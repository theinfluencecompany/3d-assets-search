import type { ProcessedAsset, RuntimeIndex } from "../../src/types.js";

const WOLF: ProcessedAsset = {
  id: "wolf-001",
  title: "Wolf",
  creator: "Quaternius",
  category: "Animals",
  tags: ["wolf", "animal"],
  animated: true,
  animationClips: ["Run", "Idle", "Attack"],
  license: "CC0",
  triCount: 1200,
  thumbnail: "https://example.com/wolf.png",
  download: "https://example.com/wolf.glb",
  polyPizzaUrl: "https://poly.pizza/wolf",
  tokenWeights: { wolf: 10, animal: 5, run: 3, idle: 3, attack: 3 },
};

const TREE: ProcessedAsset = {
  id: "tree-001",
  title: "Pine Tree",
  creator: "Quaternius",
  category: "Nature",
  tags: ["tree", "pine"],
  animated: false,
  animationClips: [],
  license: "CC0",
  triCount: 500,
  thumbnail: "https://example.com/tree.png",
  download: "https://example.com/tree.glb",
  polyPizzaUrl: "https://poly.pizza/tree",
  tokenWeights: { pine: 10, tree: 7, nature: 5 },
};

export const ASSETS = [WOLF, TREE] as const;

export const MOCK_INDEX: RuntimeIndex = {
  meta: {
    built: "2024-01-01T00:00:00.000Z",
    totalAssets: 2,
    animatedAssets: 1,
    totalTokens: 8,
  },
  assets: ASSETS,
  invertedIndex: {
    wolf: ["wolf-001"],
    animal: ["wolf-001"],
    run: ["wolf-001"],
    idle: ["wolf-001"],
    attack: ["wolf-001"],
    pine: ["tree-001"],
    tree: ["tree-001"],
    nature: ["tree-001"],
  },
  allClips: ["Attack", "Idle", "Run"],
  assetById: new Map(ASSETS.map((a) => [a.id, a])),
};
