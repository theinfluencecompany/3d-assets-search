import type { SearchResults } from "./types.js";

export function formatSearchResponse(results: SearchResults): string {
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
