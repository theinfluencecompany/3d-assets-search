import { expandTokens, stem, tokenizeRaw } from "./tokenizer.js";
import type { AssetResult, ProcessedAsset, RuntimeIndex, SearchResults } from "./types.js";

const ANIMATED_MOTION_BONUS = 5;
const PHRASE_BOOST = 1.5;
// Stemmed forms of motion words — must match what tokenize() produces.
const MOTION_TOKENS = new Set(["run", "walk", "jump", "attack", "anim", "gallop", "swim", "fly"]);

function scoreAsset(asset: ProcessedAsset, expandedTokens: readonly string[]): number {
  let score = 0;
  for (const token of expandedTokens) {
    const weight = asset.tokenWeights[token];
    if (weight !== undefined) score += weight;
  }
  const queryImpliesMotion = expandedTokens.some((t) => MOTION_TOKENS.has(t));
  if (asset.animated && queryImpliesMotion) score += ANIMATED_MOTION_BONUS;
  // Boost when all query tokens appear in the title (phrase co-occurrence signal).
  if (expandedTokens.length > 1) {
    const titleSet = new Set(asset.titleTokens);
    if (expandedTokens.every((t) => titleSet.has(t))) score *= PHRASE_BOOST;
  }
  return score;
}

function toAssetResult(asset: ProcessedAsset, score: number): AssetResult {
  return {
    id: asset.id,
    title: asset.title,
    category: asset.category,
    animated: asset.animated,
    animationClips: asset.animationClips,
    download: asset.download,
    polyPizzaUrl: asset.polyPizzaUrl,
    score: Math.round(score * 100) / 100,
  };
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
  const tokens = tokenizeRaw(query);
  // Expand synonyms on raw tokens, then stem — keeps SYNONYMS readable as plain English.
  const expanded = [...new Set(expandTokens(tokens).map(stem))];

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
      if (
        options.category &&
        !asset.category.toLowerCase().includes(options.category.toLowerCase())
      )
        return false;
      return true;
    })
    .sort((a, b) => b.score - a.score);

  const total = scored.length;

  // Fallback: if no results and multi-token query, retry scoring each token independently.
  if (total === 0 && expanded.length > 1) {
    const fallbackIds = new Set<string>();
    for (const token of expanded) {
      for (const id of index.invertedIndex[token] ?? []) fallbackIds.add(id);
    }
    const fallbackScored = [...fallbackIds]
      .map((id) => {
        const asset = index.assetById.get(id);
        return asset ? { asset, score: scoreAsset(asset, expanded) } : null;
      })
      .filter((r): r is { asset: ProcessedAsset; score: number } => r !== null && r.score > 0)
      .sort((a, b) => b.score - a.score);
    return {
      results: fallbackScored
        .slice(0, options.limit)
        .map(({ asset, score }) => toAssetResult(asset, score)),
      total: fallbackScored.length,
      offset: 0,
      hasMore: fallbackScored.length > options.limit,
      fallback: true,
    };
  }

  const page = scored.slice(options.offset, options.offset + options.limit);

  return {
    results: page.map(({ asset, score }) => toAssetResult(asset, score)),
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
  return asset ? toAssetResult(asset, 0) : undefined;
}
