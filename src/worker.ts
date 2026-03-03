/**
 * 3D Asset Search — Cloudflare Workers MCP Server
 * Transport: Streamable HTTP (remote MCP)
 * Deployment: wrangler deploy
 * Testing: npx @modelcontextprotocol/inspector http://localhost:8787/mcp
 *
 * Reuses pure search logic from this same src/ directory — no Node.js dependencies.
 * The preprocessed index is bundled at build time (1MB JSON, no file I/O at runtime).
 * GLB files are served from R2: GET /files/:id.glb (run `bun run preprocess` first to upload)
 */

// oxlint-disable-next-line triple-slash-reference -- wrangler requires this for Env type
/// <reference path="./worker-configuration.d.ts" />

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import rawIndex from "../data/asset-search-preprocessed.json";
import {
  TOOL_DEFINITIONS,
  getAssetTool,
  listAnimationClipsTool,
  listCategoriesTool,
  searchAssetsTool,
} from "./tools.js";
import type { PreprocessedIndex, RuntimeIndex } from "./types.js";

// ─── McpAgent ─────────────────────────────────────────────────────────────────

export class AssetSearchMcp extends McpAgent<Env> {
  // HACK: `agents` bundles its own copy of @modelcontextprotocol/sdk in
  // node_modules/agents/node_modules/@modelcontextprotocol/sdk. Even when
  // our top-level SDK version matches, bun/Node resolve two separate module
  // instances, making McpServer types structurally incompatible under
  // exactOptionalPropertyTypes. Declaring `server` as `any` + casting avoids
  // the false mismatch while keeping registerTool calls typed via the cast.
  // Remove once agents promotes @modelcontextprotocol/sdk to a peerDependency.
  server!: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  // Initialized in init() once.
  #index!: RuntimeIndex;

  async init() {
    // Assets in the preprocessed JSON already have R2 URLs from `bun run preprocess`.
    const parsed = rawIndex as unknown as PreprocessedIndex;
    this.#index = { ...parsed, assetById: new Map(parsed.assets.map((a) => [a.id, a])) };

    const index = this.#index;
    const server = this.server as McpServer;

    server.registerTool("search_assets", TOOL_DEFINITIONS.search_assets, (args: unknown) =>
      searchAssetsTool(index, args),
    );
    server.registerTool(
      "list_animation_clips",
      TOOL_DEFINITIONS.list_animation_clips,
      (args: unknown) => listAnimationClipsTool(index, args),
    );
    server.registerTool("list_categories", TOOL_DEFINITIONS.list_categories, () =>
      listCategoriesTool(index),
    );
    server.registerTool("get_asset", TOOL_DEFINITIONS.get_asset, (args: unknown) =>
      getAssetTool(index, args),
    );
  }
}

// ─── Worker fetch handler ──────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve GLB files from R2 with long-lived caching.
    // URL: /files/{id}.glb → R2 key: {id}.glb (bucket root)
    if (url.pathname.startsWith("/files/") && url.pathname.endsWith(".glb")) {
      const key = url.pathname.slice("/files/".length); // "{id}.glb"
      const object = await env.ASSETS_BUCKET.get(key);
      if (!object) {
        return new Response(`File not found: ${key}`, { status: 404 });
      }
      return new Response(object.body, {
        headers: {
          "Content-Type": "model/gltf-binary",
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Length": String(object.size),
        },
      });
    }

    if (url.pathname === "/mcp") {
      return AssetSearchMcp.serve("/mcp").fetch(request, env);
    }

    return new Response(
      "3d-assets-search MCP\n" +
        "  /mcp             — MCP endpoint (connect via mcp-remote)\n" +
        "  /files/:id.glb   — Serve GLB from R2 (bun run preprocess first)\n",
      { status: 200 },
    );
  },
};
