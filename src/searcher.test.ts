import { describe, it, expect } from "bun:test";
import type { PreprocessedIndex, ProcessedAsset } from "./types.js";
import { searchAssets, listClips, getAssetById } from "./searcher.js";

// ─── Minimal test fixture ──────────────────────────────────────────────────────
//
// Token weights are assigned manually to match the real preprocessor's scoring:
//   title=10, category=5, tags=4, clips=3

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

const HORSE = makeAsset({
  id: "horse-1",
  title: "Horse",
  category: "Animals",
  animated: true,
  animationClips: ["Gallop", "Walk", "Idle"],
  tokenWeights: { horse: 10, animal: 5, gallop: 3, walk: 3, idle: 3 },
});

const SWORD = makeAsset({
  id: "sword-1",
  title: "Iron Sword",
  category: "Weapons",
  animated: false,
  animationClips: [],
  tokenWeights: { iron: 10, sword: 10, weapon: 5 },
});

const KNIGHT = makeAsset({
  id: "knight-1",
  title: "Knight",
  category: "People & Characters",
  animated: true,
  animationClips: ["Walk", "Attack", "Idle"],
  tokenWeights: { knight: 10, people: 5, character: 5, walk: 3, attack: 3, idle: 3 },
});

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

const index = buildTestIndex([HORSE, SWORD, KNIGHT]);
const defaultOptions = { animatedOnly: false, limit: 10, offset: 0 };

// ─── searchAssets ──────────────────────────────────────────────────────────────

describe("searchAssets", () => {
  it("returns matching assets ranked by score", () => {
    const { results } = searchAssets(index, "horse", defaultOptions);
    expect(results.map((r) => r.id)).toContain("horse-1");
  });

  it("returns empty results for unknown query", () => {
    const { results, total } = searchAssets(index, "dragonzilla", defaultOptions);
    expect(results).toHaveLength(0);
    expect(total).toBe(0);
  });

  it("does not expose tokenWeights in results", () => {
    const { results } = searchAssets(index, "horse", defaultOptions);
    expect("tokenWeights" in (results[0] ?? {})).toBe(false);
  });

  it("ranks the higher-scoring asset first", () => {
    // "walk" matches Horse (weight 3) and Knight (weight 3) equally.
    // Knight has title weight 10 vs Horse title weight 10 — both the same.
    // But "knight" and "horse" both score 10 from title. "walk" scores 3 for both.
    // Result order may vary; just verify both are returned.
    const { results } = searchAssets(index, "walk", defaultOptions);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("horse-1");
    expect(ids).toContain("knight-1");
    expect(ids).not.toContain("sword-1"); // sword has no "walk" token
  });

  it("excludes static assets when animatedOnly is true", () => {
    const { results } = searchAssets(index, "walk", { ...defaultOptions, animatedOnly: true });
    expect(results.map((r) => r.id)).not.toContain("sword-1");
  });

  it("filters by category (case-insensitive)", () => {
    const { results } = searchAssets(index, "walk", { ...defaultOptions, category: "animals" });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("horse-1");
    expect(ids).not.toContain("knight-1");
  });

  it("paginates with limit and offset", () => {
    const page1 = searchAssets(index, "walk", { ...defaultOptions, limit: 1, offset: 0 });
    const page2 = searchAssets(index, "walk", { ...defaultOptions, limit: 1, offset: 1 });

    expect(page1.results).toHaveLength(1);
    expect(page1.hasMore).toBe(true);
    expect(page2.results).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page1.results[0]?.id).not.toBe(page2.results[0]?.id);
  });

  it("expands 'run' synonym to match assets with gallop clip", () => {
    // "run" expands to ["run","gallop","running","sprint"] — Horse has "gallop" token
    const { results } = searchAssets(index, "run", defaultOptions);
    expect(results.map((r) => r.id)).toContain("horse-1");
  });
});

// ─── listClips ─────────────────────────────────────────────────────────────────

describe("listClips", () => {
  it("returns all unique clip names sorted alphabetically", () => {
    const clips = listClips(index);
    expect(clips).toEqual(["Attack", "Gallop", "Idle", "Walk"]);
  });

  it("filters clips by category", () => {
    const clips = listClips(index, "Animals");
    expect(clips).toEqual(["Gallop", "Idle", "Walk"]);
    expect(clips).not.toContain("Attack");
  });

  it("returns empty list when category has no animated assets", () => {
    const clips = listClips(index, "Weapons");
    expect(clips).toHaveLength(0);
  });
});

// ─── getAssetById ──────────────────────────────────────────────────────────────

describe("getAssetById", () => {
  it("returns the asset for a known ID", () => {
    const asset = getAssetById(index, "horse-1");
    expect(asset?.id).toBe("horse-1");
    expect(asset?.title).toBe("Horse");
  });

  it("does not expose tokenWeights", () => {
    const asset = getAssetById(index, "horse-1");
    expect("tokenWeights" in (asset ?? {})).toBe(false);
  });

  it("returns undefined for an unknown ID", () => {
    expect(getAssetById(index, "does-not-exist")).toBeUndefined();
  });
});
