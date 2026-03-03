import { describe, expect, it } from "vitest";
import { getAssetById, listClips, searchAssets } from "../src/searcher.js";
import { TEST_INDEX } from "./fixtures.js";

const defaultOptions = { animatedOnly: false, limit: 10, offset: 0 };

// ─── searchAssets ──────────────────────────────────────────────────────────────

describe("searchAssets", () => {
	it("returns matching assets ranked by score", () => {
		const { results } = searchAssets(TEST_INDEX, "horse", defaultOptions);
		expect(results.map((r) => r.id)).toContain("horse-1");
	});

	it("returns empty results for unknown query", () => {
		const { results, total } = searchAssets(TEST_INDEX, "dragonzilla", defaultOptions);
		expect(results).toHaveLength(0);
		expect(total).toBe(0);
	});

	it("does not expose tokenWeights in results", () => {
		const { results } = searchAssets(TEST_INDEX, "horse", defaultOptions);
		expect("tokenWeights" in (results[0] ?? {})).toBe(false);
	});

	it("ranks the higher-scoring asset first", () => {
		const { results } = searchAssets(TEST_INDEX, "walk", defaultOptions);
		const ids = results.map((r) => r.id);
		expect(ids).toContain("horse-1");
		expect(ids).toContain("knight-1");
		expect(ids).not.toContain("sword-1");
	});

	it("excludes static assets when animatedOnly is true", () => {
		const { results } = searchAssets(TEST_INDEX, "walk", {
			...defaultOptions,
			animatedOnly: true,
		});
		expect(results.map((r) => r.id)).not.toContain("sword-1");
	});

	it("filters by category (case-insensitive)", () => {
		const { results } = searchAssets(TEST_INDEX, "walk", {
			...defaultOptions,
			category: "animals",
		});
		const ids = results.map((r) => r.id);
		expect(ids).toContain("horse-1");
		expect(ids).not.toContain("knight-1");
	});

	it("paginates with limit and offset", () => {
		const page1 = searchAssets(TEST_INDEX, "walk", {
			...defaultOptions,
			limit: 1,
			offset: 0,
		});
		const page2 = searchAssets(TEST_INDEX, "walk", {
			...defaultOptions,
			limit: 1,
			offset: 1,
		});

		expect(page1.results).toHaveLength(1);
		expect(page1.hasMore).toBe(true);
		expect(page2.results).toHaveLength(1);
		expect(page2.hasMore).toBe(false);
		expect(page1.results[0]?.id).not.toBe(page2.results[0]?.id);
	});

	it("expands 'run' synonym to match assets with gallop clip", () => {
		const { results } = searchAssets(TEST_INDEX, "run", defaultOptions);
		expect(results.map((r) => r.id)).toContain("horse-1");
	});
});

// ─── listClips ─────────────────────────────────────────────────────────────────

describe("listClips", () => {
	it("returns all unique clip names sorted alphabetically", () => {
		const clips = listClips(TEST_INDEX);
		expect(clips).toEqual(["Attack", "Gallop", "Idle", "Walk"]);
	});

	it("filters clips by category", () => {
		const clips = listClips(TEST_INDEX, "Animals");
		expect(clips).toEqual(["Gallop", "Idle", "Walk"]);
		expect(clips).not.toContain("Attack");
	});

	it("returns empty list when category has no animated assets", () => {
		const clips = listClips(TEST_INDEX, "Weapons");
		expect(clips).toHaveLength(0);
	});
});

// ─── getAssetById ──────────────────────────────────────────────────────────────

describe("getAssetById", () => {
	it("returns the asset for a known ID", () => {
		const asset = getAssetById(TEST_INDEX, "horse-1");
		expect(asset?.id).toBe("horse-1");
		expect(asset?.title).toBe("Horse");
	});

	it("does not expose tokenWeights", () => {
		const asset = getAssetById(TEST_INDEX, "horse-1");
		expect("tokenWeights" in (asset ?? {})).toBe(false);
	});

	it("returns undefined for an unknown ID", () => {
		expect(getAssetById(TEST_INDEX, "does-not-exist")).toBeUndefined();
	});
});
