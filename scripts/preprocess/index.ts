import { writeFileSync } from "node:fs";
import { cleanClips, tokenize } from "../../src/tokenizer.js";
import type {
  PreprocessedIndex,
  ProcessedAsset,
  PreparedAssetEntry,
  TaggedAssetEntry,
} from "../../src/types.js";
import {
  BOUNDS_MANIFEST_PATH,
  listSourceFiles,
  loadBoundsManifest,
  loadPreparedManifest,
  loadTaggedManifest,
  parseCliArgs,
  PREPROCESSED_INDEX_PATH,
  readSourceFile,
} from "../lib/runtime.js";

const FIELD_WEIGHTS = {
  title: 10,
  category: 5,
  tags: 4,
  styleTags: 4,
  clips: 3,
  creator: 2,
} as const;

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function buildRawTF(asset: Omit<ProcessedAsset, "tokenWeights" | "titleTokens">): {
  tf: Record<string, number>;
  docLength: number;
} {
  const tf: Record<string, number> = {};

  function addTokens(text: string, weight: number) {
    for (const token of tokenize(text)) {
      tf[token] = (tf[token] ?? 0) + weight;
    }
  }

  addTokens(asset.title, FIELD_WEIGHTS.title);
  addTokens(asset.category, FIELD_WEIGHTS.category);
  addTokens(asset.creator, FIELD_WEIGHTS.creator);
  for (const tag of asset.tags) addTokens(tag, FIELD_WEIGHTS.tags);
  for (const tag of asset.styleTags) addTokens(tag, FIELD_WEIGHTS.styleTags);
  for (const clip of asset.animationClips) addTokens(clip, FIELD_WEIGHTS.clips);

  const docLength = Object.values(tf).reduce((sum, value) => sum + value, 0);
  return { tf, docLength };
}

function applyBM25(
  tf: Record<string, number>,
  docLength: number,
  avgdl: number,
  df: Record<string, number>,
  totalDocs: number,
): Record<string, number> {
  const tokenWeights: Record<string, number> = {};
  for (const [token, termFreq] of Object.entries(tf)) {
    const docFreq = df[token] ?? 1;
    const idf = Math.log((totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1);
    const norm =
      (termFreq * (BM25_K1 + 1)) /
      (termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgdl)));
    tokenWeights[token] = idf * norm;
  }
  return tokenWeights;
}

function buildInvertedIndex(assets: readonly ProcessedAsset[]): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const asset of assets) {
    for (const token of Object.keys(asset.tokenWeights)) {
      index[token] ??= [];
      index[token].push(asset.id);
    }
  }
  return index;
}

function resolvePreparedUrl(assetId: string, prepared?: PreparedAssetEntry): string | null {
  if (!prepared) return null;
  if (["uploaded", "passthrough", "skipped"].includes(prepared.status)) {
    return prepared.preparedUrl;
  }
  return null;
}

function resolveStyleTags(tagged?: TaggedAssetEntry): string[] {
  if (!tagged || tagged.status !== "tagged") return [];
  return tagged.styleTags;
}

async function main() {
  const { target } = parseCliArgs(process.argv.slice(2));
  const sourceFiles = listSourceFiles(target);
  const preparedManifest = loadPreparedManifest();
  const boundsManifest = loadBoundsManifest();
  const taggedManifest = loadTaggedManifest();

  type AssetWithTF = Omit<ProcessedAsset, "tokenWeights"> & {
    _tf: Record<string, number>;
    _docLength: number;
  };

  const merged: AssetWithTF[] = [];
  const skippedModels: string[] = [];

  for (const file of sourceFiles) {
    const source = readSourceFile(file);
    console.log(`📂 ${file} (${source.platform})`);

    for (const asset of source.assets) {
      const prepared = preparedManifest.assets[asset.id];
      const download = resolvePreparedUrl(asset.id, prepared);
      if (!download) {
        if (asset.type === "model") skippedModels.push(asset.id);
        continue;
      }

      const tagged = taggedManifest.assets[asset.id];
      const bounds = boundsManifest.assets[asset.id]?.bounds;
      const styleTags = resolveStyleTags(tagged);

      const mergedAsset = {
        ...asset,
        animationClips: cleanClips(asset.animationClips),
        download,
        styleTags,
        ...(bounds ? { bounds } : {}),
        ...(tagged?.status === "tagged" && tagged.facing ? { facing: tagged.facing } : {}),
      };
      const { tf, docLength } = buildRawTF(mergedAsset);
      merged.push({
        ...mergedAsset,
        titleTokens: tokenize(mergedAsset.title),
        _tf: tf,
        _docLength: docLength,
      });
    }
  }

  if (skippedModels.length > 0) {
    console.log(
      `⚠️  Skipping ${skippedModels.length} model(s) without preparedUrl: ${skippedModels.slice(0, 10).join(", ")}${skippedModels.length > 10 ? "..." : ""}`,
    );
  }

  const totalDocs = merged.length;
  if (totalDocs === 0) {
    throw new Error(
      `No assets available for indexing. Ensure prepare has produced usable URLs and bounds manifest path exists (${BOUNDS_MANIFEST_PATH}).`,
    );
  }

  const avgdl = merged.reduce((sum, asset) => sum + asset._docLength, 0) / totalDocs;
  const df: Record<string, number> = {};
  for (const asset of merged) {
    for (const token of Object.keys(asset._tf)) {
      df[token] = (df[token] ?? 0) + 1;
    }
  }

  const assets: ProcessedAsset[] = merged.map(({ _tf, _docLength, ...asset }) => ({
    ...asset,
    tokenWeights: applyBM25(_tf, _docLength, avgdl, df, totalDocs),
  }));

  const invertedIndex = buildInvertedIndex(assets);
  const allClips = [...new Set(assets.flatMap((asset) => asset.animationClips))].sort();

  const index: PreprocessedIndex = {
    meta: {
      built: new Date().toISOString(),
      totalAssets: assets.length,
      animatedAssets: assets.filter((asset) => asset.animated).length,
      totalTokens: Object.keys(invertedIndex).length,
    },
    assets,
    invertedIndex,
    allClips,
  };

  writeFileSync(PREPROCESSED_INDEX_PATH, JSON.stringify(index));
  console.log(
    `\n✅ Index built: ${assets.length} assets | ${index.meta.animatedAssets} animated | ${index.meta.totalTokens} tokens`,
  );
  console.log(`📝 ${PREPROCESSED_INDEX_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
