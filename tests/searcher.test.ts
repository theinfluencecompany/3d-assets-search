import { describe, expect, it } from "vitest";
import { getAssetById, listClips, searchAssets } from "../src/searcher.js";
import type { ProcessedAsset, RuntimeIndex } from "../src/types.js";
import { MOCK_INDEX } from "./fixtures/mock-index.js";

const OPTS = { animatedOnly: false, limit: 10, offset: 0 };

describe("searchAssets", () => {
  it("finds asset by name token", () => {
    const { results } = searchAssets(MOCK_INDEX, "wolf", OPTS);
    expect(results.map((r) => r.id)).toContain("wolf-001");
  });

  it("returns empty results for unrecognised query", () => {
    const { results, total } = searchAssets(MOCK_INDEX, "zzznomatch", OPTS);
    expect(results).toHaveLength(0);
    expect(total).toBe(0);
    expect(searchAssets(MOCK_INDEX, "zzznomatch", OPTS).hasMore).toBe(false);
  });

  it("strips tokenWeights from returned results", () => {
    const { results } = searchAssets(MOCK_INDEX, "wolf", OPTS);
    for (const r of results) {
      expect(r).not.toHaveProperty("tokenWeights");
    }
  });

  it("animatedOnly: includes animated assets", () => {
    const { results } = searchAssets(MOCK_INDEX, "wolf", { ...OPTS, animatedOnly: true });
    expect(results.map((r) => r.id)).toContain("wolf-001");
  });

  it("animatedOnly: excludes non-animated assets", () => {
    // tree-001 is not animated — searching something it would match without filter
    const treeIndex: RuntimeIndex = {
      ...MOCK_INDEX,
      invertedIndex: { ...MOCK_INDEX.invertedIndex, wolf: ["wolf-001", "tree-001"] },
    };
    const { results } = searchAssets(treeIndex, "wolf", { ...OPTS, animatedOnly: true });
    expect(results.map((r) => r.id)).not.toContain("tree-001");
  });

  it("category: includes matching assets (case-insensitive)", () => {
    const { results } = searchAssets(MOCK_INDEX, "wolf", { ...OPTS, category: "animals" });
    expect(results.map((r) => r.id)).toContain("wolf-001");
  });

  it("category: excludes non-matching assets", () => {
    const { results } = searchAssets(MOCK_INDEX, "wolf", { ...OPTS, category: "Nature" });
    expect(results.map((r) => r.id)).not.toContain("wolf-001");
  });

  it("paginates: limit constrains result count", () => {
    const assets: ProcessedAsset[] = Array.from({ length: 5 }, (_, i) => ({
      id: `a${i}`,
      title: `Asset${i}`,
      creator: "Quaternius",
      category: "Test",
      tags: [],
      animated: false,
      animationClips: [],
      license: "CC0",
      triCount: 100,
      thumbnail: "",
      download: "",
      sourceUrl: "",
      titleTokens: ["asset"],
      tokenWeights: { test: 10 - i },
    }));
    const idx: RuntimeIndex = {
      ...MOCK_INDEX,
      assets,
      invertedIndex: { test: assets.map((a) => a.id) },
      assetById: new Map(assets.map((a) => [a.id, a])),
    };

    const page1 = searchAssets(idx, "test", { ...OPTS, limit: 2, offset: 0 });
    expect(page1.results).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(5);
    expect(page1.offset).toBe(0);

    const page2 = searchAssets(idx, "test", { ...OPTS, limit: 2, offset: 2 });
    expect(page2.results).toHaveLength(2);
    expect(page2.hasMore).toBe(true);

    const page3 = searchAssets(idx, "test", { ...OPTS, limit: 2, offset: 4 });
    expect(page3.results).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
  });
});

describe("listClips", () => {
  it("returns all unique clips sorted alphabetically", () => {
    expect(listClips(MOCK_INDEX)).toEqual(["Attack", "Idle", "Run"]);
  });

  it("filters by category (case-insensitive)", () => {
    expect(listClips(MOCK_INDEX, "animals")).toEqual(["Attack", "Idle", "Run"]);
    expect(listClips(MOCK_INDEX, "Animals")).toEqual(["Attack", "Idle", "Run"]);
  });

  it("returns empty when category has no animated assets", () => {
    expect(listClips(MOCK_INDEX, "Nature")).toEqual([]);
  });
});

describe("getAssetById", () => {
  it("returns the asset when ID exists", () => {
    const asset = getAssetById(MOCK_INDEX, "wolf-001");
    expect(asset).toBeDefined();
    expect(asset?.id).toBe("wolf-001");
    expect(asset?.title).toBe("Wolf");
  });

  it("returns undefined for an unknown ID", () => {
    expect(getAssetById(MOCK_INDEX, "does-not-exist")).toBeUndefined();
  });

  it("strips tokenWeights from returned asset", () => {
    const asset = getAssetById(MOCK_INDEX, "wolf-001");
    expect(asset).not.toHaveProperty("tokenWeights");
  });
});
