import { expandTokens, tokenize } from "./tokenizer.js";
import type { AssetResult, ProcessedAsset, RuntimeIndex, SearchResults } from "./types.js";

const ANIMATED_MOTION_BONUS = 5;
const MOTION_TOKENS = new Set(["run", "walk", "jump", "attack", "animate", "gallop", "swim", "fly"]);

function scoreAsset(asset: ProcessedAsset, expandedTokens: readonly string[]): number {
  let score = 0;
  for (const token of expandedTokens) {
    const weight = asset.tokenWeights[token];
    if (weight !== undefined) score += weight;
  }
  const queryImpliesMotion = expandedTokens.some((t) => MOTION_TOKENS.has(t));
  if (asset.animated && queryImpliesMotion) score += ANIMATED_MOTION_BONUS;
  return score;
}

function toAssetResult(asset: ProcessedAsset): AssetResult {
  const { tokenWeights: _ignored, ...rest } = asset;
  return rest;
}

interface SearchOptions {
  animatedOnly: boolean;
  category?: string;
  limit: number;
  offset: number;
}

export function searchAssets(
  index: RuntimeIndex,
  query: string,
  options: SearchOptions,
): SearchResults {
  const tokens = tokenize(query);
  const expanded = expandTokens(tokens);

  // Use inverted index to find candidate asset IDs (only assets matching at least one token)
  const candidateIds = new Set<string>();
  for (const token of expanded) {
    const ids = index.invertedIndex[token] ?? [];
    for (const id of ids) candidateIds.add(id);
  }

  const scored = [...candidateIds]
    .map((id) => {
      const asset = index.assetById.get(id);
      return asset ? { asset, score: scoreAsset(asset, expanded) } : null;
    })
    .filter((r): r is { asset: ProcessedAsset; score: number } => r !== null && r.score > 0)
    .filter(({ asset }) => {
      if (options.animatedOnly && !asset.animated) return false;
      if (options.category && !asset.category.toLowerCase().includes(options.category.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score);

  const total = scored.length;
  const page = scored.slice(options.offset, options.offset + options.limit);

  return {
    results: page.map(({ asset }) => toAssetResult(asset)),
    total,
    offset: options.offset,
    hasMore: options.offset + options.limit < total,
  };
}

export function listClips(index: RuntimeIndex, category?: string): string[] {
  const assets = index.assets.filter(
    (a) => a.animated && (!category || a.category.toLowerCase().includes(category.toLowerCase())),
  );
  return [...new Set(assets.flatMap((a) => a.animationClips))].sort();
}

export function getAssetById(index: RuntimeIndex, id: string): AssetResult | undefined {
  const asset = index.assetById.get(id);
  return asset ? toAssetResult(asset) : undefined;
}
