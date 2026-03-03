import type { ProcessedAsset, RuntimeIndex } from "../src/types.js";

// ─── Shared test fixture (3 assets: horse, sword, knight) ─────────────────────
//
// Token weights are assigned manually to match the real preprocessor's scoring:
//   title=10, category=5, tags=4, clips=3

export function makeAsset(
	overrides: Partial<ProcessedAsset> &
		Pick<
			ProcessedAsset,
			"id" | "title" | "category" | "animated" | "animationClips" | "tokenWeights"
		>,
): ProcessedAsset {
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

export const HORSE = makeAsset({
	id: "horse-1",
	title: "Horse",
	category: "Animals",
	animated: true,
	animationClips: ["Gallop", "Walk", "Idle"],
	tokenWeights: { horse: 10, animal: 5, gallop: 3, walk: 3, idle: 3 },
});

export const SWORD = makeAsset({
	id: "sword-1",
	title: "Iron Sword",
	category: "Weapons",
	animated: false,
	animationClips: [],
	tokenWeights: { iron: 10, sword: 10, weapon: 5 },
});

export const KNIGHT = makeAsset({
	id: "knight-1",
	title: "Knight",
	category: "People & Characters",
	animated: true,
	animationClips: ["Walk", "Attack", "Idle"],
	tokenWeights: {
		knight: 10,
		people: 5,
		character: 5,
		walk: 3,
		attack: 3,
		idle: 3,
	},
});

export const TEST_ASSETS = [HORSE, SWORD, KNIGHT];

export function buildTestIndex(assets: ProcessedAsset[]): RuntimeIndex {
	const invertedIndex: Record<string, string[]> = {};
	for (const asset of assets) {
		for (const token of Object.keys(asset.tokenWeights)) {
			if (!invertedIndex[token]) invertedIndex[token] = [];
			invertedIndex[token].push(asset.id);
		}
	}
	return {
		meta: {
			built: "2024-01-01T00:00:00Z",
			totalAssets: assets.length,
			animatedAssets: assets.filter((a) => a.animated).length,
			totalTokens: Object.keys(invertedIndex).length,
		},
		assets,
		invertedIndex,
		allClips: [...new Set(assets.flatMap((a) => a.animationClips))].sort(),
		assetById: new Map(assets.map((a) => [a.id, a])),
	};
}

export const TEST_INDEX = buildTestIndex(TEST_ASSETS);
