import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp-server.js";
import { TEST_ASSETS, buildTestIndex } from "./fixtures.js";

// ─── Wire up server + client via InMemoryTransport ────────────────────────────

let client: Client;

beforeAll(async () => {
	const index = buildTestIndex(TEST_ASSETS);
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
		const result = await client.callTool({
			name: "search_assets",
			arguments: { query: "horse" },
		});
		const data = JSON.parse(textFrom(result));
		expect(data.results).toBeDefined();
		expect(data.results[0].id).toBe("horse-1");
	});

	it("returns empty results with a tip when no assets match", async () => {
		const result = await client.callTool({
			name: "search_assets",
			arguments: { query: "dragonzilla" },
		});
		const data = JSON.parse(textFrom(result));
		expect(data.results).toHaveLength(0);
		expect(data.tip).toContain("No assets found");
	});

	it("respects animated_only filter", async () => {
		const result = await client.callTool({
			name: "search_assets",
			arguments: { query: "sword", animated_only: true },
		});
		const data = JSON.parse(textFrom(result));
		// Sword is not animated — should return no results
		expect(data.results).toHaveLength(0);
	});

	it("respects category filter", async () => {
		const result = await client.callTool({
			name: "search_assets",
			arguments: { query: "walk", category: "Animals" },
		});
		const data = JSON.parse(textFrom(result));
		const ids = data.results.map((r: { id: string }) => r.id);
		expect(ids).toContain("horse-1");
		expect(ids).not.toContain("knight-1");
	});

	it("includes hasMore and tip when paginating", async () => {
		const result = await client.callTool({
			name: "search_assets",
			arguments: { query: "walk", limit: 1, offset: 0 },
		});
		const data = JSON.parse(textFrom(result));
		expect(data.hasMore).toBe(true);
		expect(data.tip).toContain("offset=1");
	});
});

// ─── list_animation_clips ─────────────────────────────────────────────────────

describe("list_animation_clips tool", () => {
	it("returns all unique clip names", async () => {
		const result = await client.callTool({
			name: "list_animation_clips",
			arguments: {},
		});
		const text = textFrom(result);
		expect(text).toContain("Gallop");
		expect(text).toContain("Walk");
		expect(text).toContain("Attack");
	});

	it("filters clips by category", async () => {
		const result = await client.callTool({
			name: "list_animation_clips",
			arguments: { category: "Animals" },
		});
		const text = textFrom(result);
		expect(text).toContain("in Animals");
		expect(text).toContain("Gallop");
		expect(text).not.toContain("Attack");
	});
});

// ─── list_categories ──────────────────────────────────────────────────────────

describe("list_categories tool", () => {
	it("returns a count summary of all categories", async () => {
		const result = await client.callTool({
			name: "list_categories",
			arguments: {},
		});
		const text = textFrom(result);
		expect(text).toContain("3 total assets");
		expect(text).toContain("Animals");
		expect(text).toContain("Weapons");
	});
});

// ─── get_asset ────────────────────────────────────────────────────────────────

describe("get_asset tool", () => {
	it("returns asset JSON for a known ID", async () => {
		const result = await client.callTool({
			name: "get_asset",
			arguments: { id: "horse-1" },
		});
		const data = JSON.parse(textFrom(result));
		expect(data.id).toBe("horse-1");
		expect(data.title).toBe("Horse");
		expect(data.download).toBeDefined();
	});

	it("returns isError for an unknown ID", async () => {
		const result = await client.callTool({
			name: "get_asset",
			arguments: { id: "does-not-exist" },
		});
		expect(result.isError).toBe(true);
	});
});
