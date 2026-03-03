/**
 * 3D Asset Search — Cloudflare Workers MCP Server
 * Transport: Streamable HTTP (remote MCP)
 * Deployment: wrangler deploy
 * Testing: npx @modelcontextprotocol/inspector http://localhost:8787/mcp
 *
 * Reuses pure search logic from ../src — no Node.js dependencies.
 * The preprocessed index is bundled at build time (1MB JSON, no file I/O at runtime).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
// Bundled by wrangler at build time — no runtime file I/O.
import rawIndex from "../../data/asset-search-preprocessed.json";
import {
  getAssetTool,
  listAnimationClipsTool,
  listCategoriesTool,
  searchAssetsTool,
  TOOL_DEFINITIONS,
} from "../../src/tools.js";
import type { PreprocessedIndex, RuntimeIndex } from "../../src/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

// No environment bindings required for a public read-only server.
type Env = Record<string, never>;

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// ─── McpAgent ─────────────────────────────────────────────────────────────────

export class AssetSearchMcp extends McpAgent<Env> {
  // McpAgent requires server to be declared (initialized by the base class)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server!: any;

  // Build the RuntimeIndex once per Durable Object instance.
  // The Map gives O(1) get_asset lookups without a per-call rebuild.
  #index: RuntimeIndex = (() => {
    const parsed = rawIndex as unknown as PreprocessedIndex;
    return {
      ...parsed,
      assetById: new Map(parsed.assets.map((a) => [a.id, a])),
    };
  })();

  async init() {
    const index = this.#index;
    const mcpServer = this.server as McpServer;

    mcpServer.registerTool("search_assets", TOOL_DEFINITIONS.search_assets, (args: unknown) =>
      searchAssetsTool(index, args),
    );

    mcpServer.registerTool(
      "list_animation_clips",
      TOOL_DEFINITIONS.list_animation_clips,
      (args: unknown) => listAnimationClipsTool(index, args),
    );

    mcpServer.registerTool("list_categories", TOOL_DEFINITIONS.list_categories, () =>
      listCategoriesTool(index),
    );

    mcpServer.registerTool("get_asset", TOOL_DEFINITIONS.get_asset, (args: unknown) =>
      getAssetTool(index, args),
    );
  }
}

// ─── Worker export ────────────────────────────────────────────────────────────

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return AssetSearchMcp.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response("3d-assets-search MCP | Connect at /mcp", {
      status: 200,
    });
  },
};
