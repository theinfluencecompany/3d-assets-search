/**
 * Shared tool definitions for both stdio and Cloudflare Workers transports.
 * Tool implementations are transport-agnostic and return structured data.
 */

import { z } from "zod";
import { getAssetById, listClips, searchAssets } from "./searcher.js";
import {
  GetAssetInputSchema,
  ListClipsInputSchema,
  type RuntimeIndex,
  SearchAssetsInputSchema,
  type SearchResults,
} from "./types.js";

// ─── Tool Result Types ────────────────────────────────────────────────────────

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [x: string]: unknown;
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

function toolError(prefix: string, error: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}

function formatSearchResponse(results: SearchResults): string {
  return JSON.stringify({
    results: results.results,
    total: results.total,
    hasMore: results.hasMore,
    tip:
      results.results.length === 0
        ? "No assets found. Try broader terms or remove filters."
        : results.hasMore
          ? `Use offset=${results.offset + results.results.length} for next page.`
          : undefined,
  });
}

// ─── Tool Implementations ─────────────────────────────────────────────────────

export function searchAssetsTool(index: RuntimeIndex, args: unknown): ToolResult {
  try {
    const input = SearchAssetsInputSchema.parse(args);
    const results = searchAssets(index, input.query, {
      animatedOnly: input.animated_only,
      limit: input.limit,
      offset: input.offset,
      ...(input.category !== undefined ? { category: input.category } : {}),
    });
    return {
      content: [{ type: "text", text: formatSearchResponse(results) }],
    };
  } catch (error) {
    return toolError("Search error", error);
  }
}

export function listAnimationClipsTool(index: RuntimeIndex, args: unknown): ToolResult {
  try {
    const { category } = ListClipsInputSchema.parse(args);
    const clips = listClips(index, category);
    const text = `${clips.length} unique clips${category ? ` in ${category}` : ""}:\n${clips.join(", ")}`;
    return { content: [{ type: "text", text }] };
  } catch (error) {
    return toolError("List clips error", error);
  }
}

export function listCategoriesTool(index: RuntimeIndex): ToolResult {
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
}

export function getAssetTool(index: RuntimeIndex, args: unknown): ToolResult {
  try {
    const { id } = GetAssetInputSchema.parse(args);
    const asset = getAssetById(index, id);
    if (!asset) {
      return {
        content: [{ type: "text", text: `Asset "${id}" not found.` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(asset, null, 2) }],
    };
  } catch (error) {
    return toolError("Get asset error", error);
  }
}

// ─── Tool Metadata ────────────────────────────────────────────────────────────

/** Schema for tools with no required arguments */
const EmptyInputSchema = z.object({}).strict();

export const TOOL_DEFINITIONS = {
  search_assets: {
    description: [
      "Search 1400+ low-poly 3D assets (Quaternius) by name, type, or animation.",
      "Returns multiple ranked results with direct GLB download URLs usable immediately in Three.js/R3F.",
      "Supports semantic synonyms: 'run' finds Gallop, 'attack' finds Bite/Slash/Punch, 'die' finds Death, 'hit' finds HitReact.",
      "Returns several options so you can pick the best fit for the game context.",
    ].join(" "),
    inputSchema: SearchAssetsInputSchema,
  },
  list_animation_clips: {
    description: [
      "List all unique animation clip names available across animated assets.",
      "Call this before search_assets to discover what motions exist.",
      "Optionally filter by category (e.g. 'Animals') to see clips for a specific asset type.",
    ].join(" "),
    inputSchema: ListClipsInputSchema,
  },
  list_categories: {
    description:
      "List all asset categories with counts. Call this to understand what kinds of assets are available before searching.",
    inputSchema: EmptyInputSchema,
  },
  get_asset: {
    description: [
      "Get full details for one specific asset by ID.",
      "Use after search_assets to confirm the exact download URL and animation clip names before using in code.",
    ].join(" "),
    inputSchema: GetAssetInputSchema,
  },
};
