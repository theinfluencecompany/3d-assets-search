import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PreprocessedIndex, ProcessedAsset } from "../src/types.js";
import { createServer } from "../src/mcp-server.js";

// ─── Shared test fixture (same 3 assets used in searcher tests) ───────────────

function makeAsset(overrides: Partial<ProcessedAsset> & Pick<ProcessedAsset, "id" | "title" | "category" | "animated" | "animationClips" | "tokenWeights">): ProcessedAsset {
  return {
    creator: "Quaternius",
    tags: [],
    license: "CC0",
    triCount: 100,
    thumbnail: "https://example.com/thumb.jpg",
    download: "https://example.com/model.glb",
    polyPizzaUrl: "https://poly.pizza/m/test",
    ...overrides,
  };
}

const ASSETS = [
  makeAsset({ id: "horse-1", title: "Horse", category: "Animals", animated: true, animationClips: ["Gallop", "Walk", "Idle"], tokenWeights: { horse: 10, animal: 5, gallop: 3, walk: 3, idle: 3 } }),
  makeAsset({ id: "sword-1", title: "Iron Sword", category: "Weapons", animated: false, animationClips: [], tokenWeights: { iron: 10, sword: 10, weapon: 5 } }),
  makeAsset({ id: "knight-1", title: "Knight", category: "People & Characters", animated: true, animationClips: ["Walk", "Attack", "Idle"], tokenWeights: { knight: 10, people: 5, character: 5, walk: 3, attack: 3, idle: 3 } }),
];

function buildTestIndex(assets: ProcessedAsset[]): PreprocessedIndex {
  const invertedIndex: Record<string, string[]> = {};
  for (const asset of assets) {
    for (const token of Object.keys(asset.tokenWeights)) {
      (invertedIndex[token] ??= []).push(asset.id);
    }
  }
  return {
    meta: { built: "2024-01-01T00:00:00Z", totalAssets: assets.length, animatedAssets: assets.filter((a) => a.animated).length, totalTokens: Object.keys(invertedIndex).length },
    assets,
    invertedIndex,
    allClips: [...new Set(assets.flatMap((a) => a.animationClips))].sort(),
  };
}

// ─── Wire up server + client via InMemoryTransport ────────────────────────────

let client: Client;

beforeAll(async () => {
  const index = buildTestIndex(ASSETS);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = createServer(index);
  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

function textFrom(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text content");
  return first.text;
}

// ─── tools/list ───────────────────────────────────────────────────────────────

describe("tools/list", () => {
  it("exposes all 4 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_assets");
    expect(names).toContain("list_animation_clips");
    expect(names).toContain("list_categories");
    expect(names).toContain("get_asset");
  });
});

// ─── search_assets ────────────────────────────────────────────────────────────

describe("search_assets tool", () => {
  it("returns JSON with results array for a matching query", async () => {
    const result = await client.callTool({ name: "search_assets", arguments: { query: "horse" } });
    const data = JSON.parse(textFrom(result));
    expect(data.results).toBeDefined();
    expect(data.results[0].id).toBe("horse-1");
  });

  it("returns error JSON when no assets match", async () => {
    const result = await client.callTool({ name: "search_assets", arguments: { query: "dragonzilla" } });
    const data = JSON.parse(textFrom(result));
    expect(data.error).toBeDefined();
  });

  it("respects animated_only filter", async () => {
    const result = await client.callTool({ name: "search_assets", arguments: { query: "sword", animated_only: true } });
    const data = JSON.parse(textFrom(result));
    // Sword is not animated — should return no results
    expect(data.error).toBeDefined();
  });

  it("respects category filter", async () => {
    const result = await client.callTool({ name: "search_assets", arguments: { query: "walk", category: "Animals" } });
    const data = JSON.parse(textFrom(result));
    const ids = data.results.map((r: { id: string }) => r.id);
    expect(ids).toContain("horse-1");
    expect(ids).not.toContain("knight-1");
  });

  it("includes hasMore and tip when paginating", async () => {
    const result = await client.callTool({ name: "search_assets", arguments: { query: "walk", limit: 1, offset: 0 } });
    const data = JSON.parse(textFrom(result));
    expect(data.hasMore).toBe(true);
    expect(data.tip).toContain("offset=1");
  });
});

// ─── list_animation_clips ─────────────────────────────────────────────────────

describe("list_animation_clips tool", () => {
  it("returns all unique clip names", async () => {
    const result = await client.callTool({ name: "list_animation_clips", arguments: {} });
    const text = textFrom(result);
    expect(text).toContain("Gallop");
    expect(text).toContain("Walk");
    expect(text).toContain("Attack");
  });

  it("filters clips by category", async () => {
    const result = await client.callTool({ name: "list_animation_clips", arguments: { category: "Animals" } });
    const text = textFrom(result);
    expect(text).toContain("in Animals");
    expect(text).toContain("Gallop");
    expect(text).not.toContain("Attack");
  });
});

// ─── list_categories ──────────────────────────────────────────────────────────

describe("list_categories tool", () => {
  it("returns a count summary of all categories", async () => {
    const result = await client.callTool({ name: "list_categories", arguments: {} });
    const text = textFrom(result);
    expect(text).toContain("3 total assets");
    expect(text).toContain("Animals");
    expect(text).toContain("Weapons");
  });
});

// ─── get_asset ────────────────────────────────────────────────────────────────

describe("get_asset tool", () => {
  it("returns asset JSON for a known ID", async () => {
    const result = await client.callTool({ name: "get_asset", arguments: { id: "horse-1" } });
    const data = JSON.parse(textFrom(result));
    expect(data.id).toBe("horse-1");
    expect(data.title).toBe("Horse");
    expect(data.download).toBeDefined();
  });

  it("returns isError for an unknown ID", async () => {
    const result = await client.callTool({ name: "get_asset", arguments: { id: "does-not-exist" } });
    expect(result.isError).toBe(true);
  });
});
