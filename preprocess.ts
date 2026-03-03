/**
 * Build script — run once to generate the optimized search index.
 * Usage: bun preprocess.ts
 * Input:  data/quaternius-index.json
 * Output: data/asset-search-preprocessed.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type ProcessedAsset, type PreprocessedIndex } from "./src/types.js";
import { cleanClips, tokenize } from "./src/tokenizer.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");
const OUT_FILE = join(DATA_DIR, "asset-search-preprocessed.json");

/** Shape of each entry in the raw poly.pizza export files. */
const RawFileAssetSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  animated: z.boolean(),
  animationClips: z.array(z.string()).default([]),
  license: z.string(),
  triCount: z.number(),
  thumbnail: z.string(),
  download: z.string(),
  polyPizzaUrl: z.string(),
});

const RawFileIndexSchema = z.object({ assets: z.array(RawFileAssetSchema) });

const FIELD_WEIGHTS = { title: 10, category: 5, tags: 4, clips: 3, creator: 2 } as const;

function loadRawAssets(file: string, creator: string) {
  const fullPath = join(DATA_DIR, file);
  if (!existsSync(fullPath)) {
    console.warn(`⚠ Skipping missing file: ${file}`);
    return [];
  }
  const parsed = RawFileIndexSchema.parse(JSON.parse(readFileSync(fullPath, "utf8")));
  return parsed.assets.map((a) => ({ ...a, creator }));
}

function buildTokenWeights(asset: Omit<ProcessedAsset, "tokenWeights">): Record<string, number> {
  const weights: Record<string, number> = {};

  function addTokens(text: string, weight: number) {
    for (const token of tokenize(text)) {
      weights[token] = Math.max(weights[token] ?? 0, weight);
    }
  }

  addTokens(asset.title, FIELD_WEIGHTS.title);
  addTokens(asset.category, FIELD_WEIGHTS.category);
  addTokens(asset.creator, FIELD_WEIGHTS.creator);
  for (const tag of asset.tags) addTokens(tag, FIELD_WEIGHTS.tags);
  for (const clip of asset.animationClips) {
    // Tokenize so "Sword_Slash" → ["sword","slash"] — both become searchable
    for (const t of tokenize(clip)) {
      weights[t] = Math.max(weights[t] ?? 0, FIELD_WEIGHTS.clips);
    }
    // Also index the full clean name for exact clip searches
    const fullToken = clip.toLowerCase().replace(/_/g, "");
    weights[fullToken] = Math.max(weights[fullToken] ?? 0, FIELD_WEIGHTS.clips);
  }

  return weights;
}

function buildInvertedIndex(assets: readonly ProcessedAsset[]): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const asset of assets) {
    for (const token of Object.keys(asset.tokenWeights)) {
      (index[token] ??= []).push(asset.id);
    }
  }
  return index;
}

function main() {
  const raw = loadRawAssets("quaternius-index.json", "Quaternius");

  const assets: ProcessedAsset[] = raw.map((a) => {
    const cleaned = { ...a, animationClips: cleanClips(a.animationClips) };
    return { ...cleaned, tokenWeights: buildTokenWeights(cleaned) };
  });

  const invertedIndex = buildInvertedIndex(assets);
  const allClips = [...new Set(assets.flatMap((a) => a.animationClips))].sort();

  const index: PreprocessedIndex = {
    meta: {
      built: new Date().toISOString(),
      totalAssets: assets.length,
      animatedAssets: assets.filter((a) => a.animated).length,
      totalTokens: Object.keys(invertedIndex).length,
    },
    assets,
    invertedIndex,
    allClips,
  };

  writeFileSync(OUT_FILE, JSON.stringify(index));

  console.log(`✅ ${assets.length} assets | ${index.meta.animatedAssets} animated | ${index.meta.totalTokens} tokens`);
  console.log(`📝 ${OUT_FILE}`);
}

main();
