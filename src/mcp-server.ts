/**
 * 3D Asset Search MCP Server
 * Transport: stdio (local use with Claude Code / Claude Desktop)
 * Usage: bun src/mcp-server.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type PreprocessedIndex, SearchAssetsInputSchema, ListClipsInputSchema, GetAssetInputSchema } from "./types.js";
import { searchAssets, listClips, getAssetById } from "./searcher.js";

const INDEX_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "asset-search-preprocessed.json");

function loadIndex(): PreprocessedIndex {
  if (!existsSync(INDEX_PATH)) {
    throw new Error(`Preprocessed index not found at ${INDEX_PATH}. Run: bun preprocess.ts`);
  }
  return JSON.parse(readFileSync(INDEX_PATH, "utf8")) as PreprocessedIndex;
}

function formatSearchResponse(results: ReturnType<typeof searchAssets>): string {
  if (results.results.length === 0) {
    return JSON.stringify({ error: "No assets found. Try broader terms or remove filters." });
  }
  return JSON.stringify({
    results: results.results,
    total: results.total,
    hasMore: results.hasMore,
    tip: results.hasMore ? `Use offset=${results.offset + results.results.length} for next page.` : undefined,
  });
}

/** Create and configure the MCP server. Exported for testing via InMemoryTransport. */
export function createServer(index: PreprocessedIndex): McpServer {
  const server = new McpServer({ name: "3d-assets-search", version: "1.0.0" });

  server.registerTool(
    "search_assets",
    {
      description: [
        "Search 1400+ low-poly 3D assets (Quaternius) by name, type, or animation.",
        "Returns multiple ranked results with direct GLB download URLs usable immediately in Three.js/R3F.",
        "Supports semantic synonyms: 'run' finds Gallop, 'attack' finds Bite/Slash/Punch, 'die' finds Death, 'hit' finds HitReact.",
        "Returns several options so you can pick the best fit for the game context.",
      ].join(" "),
      inputSchema: SearchAssetsInputSchema.shape,
    },
    (args) => {
      const input = SearchAssetsInputSchema.parse(args);
      const results = searchAssets(index, input.query, {
        animatedOnly: input.animated_only,
        limit: input.limit,
        offset: input.offset,
        ...(input.category !== undefined ? { category: input.category } : {}),
      });
      return { content: [{ type: "text", text: formatSearchResponse(results) }] };
    },
  );

  server.registerTool(
    "list_animation_clips",
    {
      description: [
        "List all unique animation clip names available across animated assets.",
        "Call this before search_assets to discover what motions exist.",
        "Optionally filter by category (e.g. 'Animals') to see clips for a specific asset type.",
      ].join(" "),
      inputSchema: ListClipsInputSchema.shape,
    },
    (args) => {
      const { category } = ListClipsInputSchema.parse(args);
      const clips = listClips(index, category);
      const text = `${clips.length} unique clips${category ? ` in ${category}` : ""}:\n${clips.join(", ")}`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "list_categories",
    {
      description: "List all asset categories with counts. Call this to understand what kinds of assets are available before searching.",
    },
    () => {
      const counts: Record<string, number> = {};
      for (const asset of index.assets) {
        const key = `${asset.category} (${asset.creator})`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      const lines = Object.entries(counts)
        .sort(([, a], [, b]) => b - a)
        .map(([cat, n]) => `  ${n}× ${cat}`);
      const animated = index.assets.filter((a) => a.animated).length;
      const text = `${index.assets.length} total assets (${animated} animated):\n${lines.join("\n")}`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "get_asset",
    {
      description: [
        "Get full details for one specific asset by ID.",
        "Use after search_assets to confirm the exact download URL and animation clip names before using in code.",
      ].join(" "),
      inputSchema: GetAssetInputSchema.shape,
    },
    (args) => {
      const { id } = GetAssetInputSchema.parse(args);
      const asset = getAssetById(index, id);
      if (!asset) return { content: [{ type: "text", text: `Asset "${id}" not found.` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(asset, null, 2) }] };
    },
  );

  return server;
}

function main() {
  const index = loadIndex();
  const server = createServer(index);
  const transport = new StdioServerTransport();
  server.connect(transport);
  process.stderr.write(
    `3d-assets-search MCP ready | ${index.meta.totalAssets} assets | ${index.meta.animatedAssets} animated\n`,
  );
}

main();
