/**
 * 3D Asset Search MCP Server
 * Transport: stdio (local use with Claude Code / Claude Desktop)
 * Usage: bun src/mcp-server.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  getAssetTool,
  listAnimationClipsTool,
  listCategoriesTool,
  searchAssetsTool,
  TOOL_DEFINITIONS,
} from "./tools.js";
import { PreprocessedIndexSchema, type RuntimeIndex } from "./types.js";

const INDEX_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "asset-search-preprocessed.json",
);

function loadIndex(): RuntimeIndex {
  if (!existsSync(INDEX_PATH)) {
    throw new Error(`Preprocessed index not found. Run: bun run preprocess`);
  }
  const parsed = PreprocessedIndexSchema.parse(JSON.parse(readFileSync(INDEX_PATH, "utf8")));
  return { ...parsed, assetById: new Map(parsed.assets.map((a) => [a.id, a])) };
}

/** Create and configure the MCP server. Exported for testing via InMemoryTransport. */
export function createServer(index: RuntimeIndex): McpServer {
  const server = new McpServer({ name: "3d-assets-search", version: "1.0.0" });

  server.registerTool("search_assets", TOOL_DEFINITIONS.search_assets, (args) =>
    searchAssetsTool(index, args),
  );

  server.registerTool("list_animation_clips", TOOL_DEFINITIONS.list_animation_clips, (args) =>
    listAnimationClipsTool(index, args),
  );

  server.registerTool("list_categories", TOOL_DEFINITIONS.list_categories, () =>
    listCategoriesTool(index),
  );

  server.registerTool("get_asset", TOOL_DEFINITIONS.get_asset, (args) => getAssetTool(index, args));

  return server;
}

async function main() {
  const index = loadIndex();
  const server = createServer(index);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `3d-assets-search MCP ready | ${index.meta.totalAssets} assets | ${index.meta.animatedAssets} animated\n`,
  );
}

// Only run when executed directly — not when imported in tests.
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
