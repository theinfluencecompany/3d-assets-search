/**
 * MCP protocol integration tests.
 * Uses InMemoryTransport so no stdio or file I/O is required.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp-server.js";
import { MOCK_INDEX } from "./fixtures/mock-index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function startTestServer() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(MOCK_INDEX);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return { client, server };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text content");
  return first.text;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MCP server — tool registration", () => {
  it("exposes exactly the four expected tools", async () => {
    const { client } = await startTestServer();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_asset",
      "list_animation_clips",
      "list_categories",
      "search_assets",
    ]);
  });
});

describe("search_assets tool", () => {
  it("returns results for a matching query", async () => {
    const { client } = await startTestServer();
    const result = await client.callTool({ name: "search_assets", arguments: { query: "wolf" } });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.results.some((r: { id: string }) => r.id === "wolf-001")).toBe(true);
  });

  it("returns tip on no results", async () => {
    const { client } = await startTestServer();
    const result = await client.callTool({
      name: "search_assets",
      arguments: { query: "zzznomatch" },
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.total).toBe(0);
    expect(parsed.tip).toMatch(/no assets found/i);
  });

  it("returns pagination tip when there are more results", async () => {
    const { client } = await startTestServer();
    const result = await client.callTool({
      name: "search_assets",
      arguments: { query: "wolf", limit: 1, offset: 0 },
    });
    // MOCK_INDEX only has 1 wolf result — no more, so no pagination tip
    const parsed = JSON.parse(textOf(result));
    expect(parsed.hasMore).toBe(false);
  });

  it("is not marked isError on empty results", async () => {
    const { client } = await startTestServer();
    const result = await client.callTool({
      name: "search_assets",
      arguments: { query: "zzznomatch" },
    });
    expect(result.isError).toBeFalsy();
  });
});

describe("list_animation_clips tool", () => {
  it("lists all clips when no category filter", async () => {
    const { client } = await startTestServer();
    const result = await client.callTool({ name: "list_animation_clips", arguments: {} });
    const text = textOf(result);
    expect(text).toContain("Run");
    expect(text).toContain("Idle");
    expect(text).toContain("Attack");
  });

  it("filters clips by category", async () => {
    const { client } = await startTestServer();
    const result = await client.callTool({
      name: "list_animation_clips",
      arguments: { category: "Animals" },
    });
    const text = textOf(result);
    expect(text).toContain("Run");
  });

  it("returns 0 clips for a category with no animated assets", async () => {
    const { client } = await startTestServer();
    const result = await client.callTool({
      name: "list_animation_clips",
      arguments: { category: "Nature" },
    });
    expect(textOf(result)).toContain("0 unique clips");
  });
});

describe("list_categories tool", () => {
  it("returns category counts", async () => {
    const { client } = await startTestServer();
    const result = await client.callTool({ name: "list_categories", arguments: {} });
    const text = textOf(result);
    expect(text).toContain("Animals");
    expect(text).toContain("Nature");
    expect(text).toContain("2 total assets");
  });
});

describe("get_asset tool", () => {
  it("returns full asset JSON for a valid ID", async () => {
    const { client } = await startTestServer();
    const result = await client.callTool({ name: "get_asset", arguments: { id: "wolf-001" } });
    expect(result.isError).toBeFalsy();
    const asset = JSON.parse(textOf(result));
    expect(asset.id).toBe("wolf-001");
    expect(asset.title).toBe("Wolf");
    expect(asset).not.toHaveProperty("tokenWeights");
  });

  it("returns isError: true for unknown ID", async () => {
    const { client } = await startTestServer();
    const result = await client.callTool({
      name: "get_asset",
      arguments: { id: "does-not-exist" },
    });
    expect(result.isError).toBe(true);
  });
});
