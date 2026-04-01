import { z } from "zod";

// ─── Raw JSON index shape ─────────────────────────────────────────────────────

export const RawAssetSchema = z.object({
  id: z.string(),
  title: z.string(),
  creator: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  animated: z.boolean(),
  animationClips: z.array(z.string()),
  license: z.string(),
  triCount: z.number(),
  thumbnail: z.string(),
  download: z.string(),
  polyPizzaUrl: z.string(),
});

export const RawIndexSchema = z.object({
  assets: z.array(RawAssetSchema),
});

export type RawAsset = z.infer<typeof RawAssetSchema>;

// ─── Preprocessed index (built once by preprocess.ts, loaded at startup) ─────

export const ProcessedAssetSchema = RawAssetSchema.extend({
  /** token → BM25 score pre-baked at index build time */
  tokenWeights: z.record(z.string(), z.number()),
  /** stemmed title tokens for phrase boost detection */
  titleTokens: z.array(z.string()),
});

export const PreprocessedIndexSchema = z.object({
  meta: z.object({
    built: z.string(),
    totalAssets: z.number(),
    animatedAssets: z.number(),
    totalTokens: z.number(),
  }),
  assets: z.array(ProcessedAssetSchema),
  /** token → asset IDs — O(1) candidate lookup */
  invertedIndex: z.record(z.string(), z.array(z.string())),
  /** all unique clean animation clip names, sorted */
  allClips: z.array(z.string()),
});

export type ProcessedAsset = z.infer<typeof ProcessedAssetSchema>;
export type PreprocessedIndex = z.infer<typeof PreprocessedIndexSchema>;

/** PreprocessedIndex + in-memory Map built once at load. Not serializable to JSON. */
export interface RuntimeIndex extends PreprocessedIndex {
  /** O(1) asset lookup by ID — built once in loadIndex(), never rebuilt */
  readonly assetById: ReadonlyMap<string, ProcessedAsset>;
}

// ─── Tool input schemas (Zod → runtime validation + TypeScript types) ─────────

export const SearchAssetsInputSchema = z.object({
  query: z.string().min(1),
  animated_only: z.boolean().default(false),
  category: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(8),
  offset: z.number().int().min(0).default(0),
});

export const ListClipsInputSchema = z.object({
  category: z.string().optional(),
});

export const GetAssetInputSchema = z.object({
  id: z.string(),
});

export type SearchAssetsInput = z.infer<typeof SearchAssetsInputSchema>;
export type ListClipsInput = z.infer<typeof ListClipsInputSchema>;
export type GetAssetInput = z.infer<typeof GetAssetInputSchema>;

// ─── What Claude sees in search results (no internal fields) ─────────────────

export type AssetResult = {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly animated: boolean;
  readonly animationClips: readonly string[];
  readonly download: string;
  readonly polyPizzaUrl: string;
  readonly score: number;
};

export interface SearchResults {
  readonly results: readonly AssetResult[];
  readonly total: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly fallback?: boolean;
}
