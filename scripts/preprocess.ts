/**
 * Build script — generates the optimized search index from raw source files.
 * Open-access sources (e.g. poly.pizza) use their CDN URLs directly.
 * Restricted sources upload GLBs to Cloudflare R2 and rewrite download URLs.
 *
 * Usage: bun run preprocess   (or automatically via `bun run pipeline`)
 *
 * Input:  data/sources/*.json        (one file per creator, includes "platform" field)
 *         data/sources.config.json   (maps platforms → access mode)
 * Output: data/asset-search-preprocessed.json
 *
 * Adding a new source:
 *   1. Drop data/sources/<creator>.json  (with "platform": "poly.pizza" field)
 *   2. Run bun run preprocess  (no config changes needed for known platforms)
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { cleanClips, tokenize } from "../src/tokenizer.js";
import { type PreprocessedIndex, type ProcessedAsset, RawAssetSchema } from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_DIR = join(ROOT, "data", "sources");
const SOURCES_CONFIG_FILE = join(ROOT, "data", "sources.config.json");
const OUT_FILE = join(ROOT, "data", "asset-search-preprocessed.json");

// ─── Sources Config ────────────────────────────────────────────────────────────

const SourcesConfigSchema = z.object({
  platforms: z.record(
    z.string(),
    z.object({ access: z.enum(["open", "restricted"]), creators: z.array(z.string()).optional() }),
  ),
});

type SourcesConfig = z.infer<typeof SourcesConfigSchema>;

function loadSourcesConfig(): SourcesConfig {
  return SourcesConfigSchema.parse(JSON.parse(readFileSync(SOURCES_CONFIG_FILE, "utf8")));
}

function getAccessMode(platform: string, config: SourcesConfig): "open" | "restricted" {
  return config.platforms[platform]?.access ?? "restricted"; // safe default for unknown platforms
}

// ─── R2 Config ─────────────────────────────────────────────────────────────────

const R2EnvSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  R2_BUCKET: z.string().default("3d-assets"),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
});

const ASSETS_BASE_URL = process.env.ASSETS_BASE_URL ?? "https://assets.fried.gg";

let r2Client: S3Client | null = null;
let r2Bucket: string | null = null;

function initR2Client(): boolean {
  const result = R2EnvSchema.safeParse(process.env);
  if (!result.success) return false;

  const env = result.data;
  r2Bucket = env.R2_BUCKET;
  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  return true;
}

// ─── Source schema ─────────────────────────────────────────────────────────────

const RawFileAssetSchema = RawAssetSchema.omit({ creator: true }).extend({
  animationClips: RawAssetSchema.shape.animationClips.default([]),
});

const RawFileIndexSchema = z.object({
  platform: z.string().default("restricted"),
  assets: z.array(RawFileAssetSchema),
});

type RawFileAsset = z.infer<typeof RawFileAssetSchema>;

const FIELD_WEIGHTS = {
  title: 10,
  category: 5,
  tags: 4,
  clips: 3,
  creator: 2,
} as const;

function creatorFromFilename(file: string): string {
  const stem = basename(file, ".json");
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

function loadRawAssets(
  file: string,
  creator: string,
): { platform: string; assets: Array<RawFileAsset & { creator: string }> } {
  const parsed = RawFileIndexSchema.parse(
    JSON.parse(readFileSync(join(SOURCES_DIR, file), "utf8")),
  );
  return { platform: parsed.platform, assets: parsed.assets.map((a) => ({ ...a, creator })) };
}

// BM25 parameters
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Pass 1: compute raw weighted TF and document length for one asset. */
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
  for (const clip of asset.animationClips) addTokens(clip, FIELD_WEIGHTS.clips);

  const docLength = Object.values(tf).reduce((s, v) => s + v, 0);
  return { tf, docLength };
}

/** Pass 2: given corpus stats, compute final BM25 tokenWeights for one asset. */
function applyBM25(
  tf: Record<string, number>,
  docLength: number,
  avgdl: number,
  df: Record<string, number>,
  N: number,
): Record<string, number> {
  const tokenWeights: Record<string, number> = {};
  for (const [token, termFreq] of Object.entries(tf)) {
    const docFreq = df[token] ?? 1;
    const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
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

// ─── R2 Upload ─────────────────────────────────────────────────────────────────

async function existsInR2(key: string): Promise<boolean> {
  if (!r2Client || !r2Bucket) return false;
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadAsset(
  id: string,
  downloadUrl: string,
): Promise<{ status: "uploaded" | "skipped" | "failed"; reason?: string }> {
  const key = `${id}.glb`; // Store at bucket root

  // Skip if already in R2
  if (await existsInR2(key)) {
    return { status: "skipped" };
  }

  // Download from source
  let body: ArrayBuffer;
  try {
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.arrayBuffer();
  } catch (err) {
    return {
      status: "failed",
      reason: `download: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Upload to R2
  try {
    await r2Client!.send(
      new PutObjectCommand({
        Bucket: r2Bucket!,
        Key: key,
        Body: new Uint8Array(body),
        ContentType: "model/gltf-binary",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return { status: "uploaded" };
  } catch (err) {
    return {
      status: "failed",
      reason: `upload: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const sourceFiles = readdirSync(SOURCES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (sourceFiles.length === 0) {
    console.error("No JSON files found in data/sources/. Add at least one source file.");
    process.exit(1);
  }

  const accessConfig = loadSourcesConfig();

  // Load all raw assets from source files, tracking platform per asset
  type RawWithPlatform = RawFileAsset & { creator: string; platform: string };
  const raw: RawWithPlatform[] = sourceFiles.flatMap((file) => {
    const creator = creatorFromFilename(file);
    const { platform, assets } = loadRawAssets(file, creator);
    const mode = getAccessMode(platform, accessConfig);
    console.log(`📂 sources/${file} → creator: ${creator}, platform: ${platform} (${mode})`);
    return assets.map((a) => ({ ...a, platform }));
  });

  console.log(`\n📊 Found ${raw.length} assets to process`);

  // Partition by access mode
  const restricted = raw.filter((a) => getAccessMode(a.platform, accessConfig) === "restricted");
  const open = raw.filter((a) => getAccessMode(a.platform, accessConfig) === "open");

  console.log(`   ${open.length} open-access (CDN URL used as-is)`);
  console.log(`   ${restricted.length} restricted (R2 upload required)`);

  // Upload restricted assets to R2
  if (restricted.length > 0) {
    const r2Enabled = initR2Client();
    if (r2Enabled) {
      console.log(`\n☁️  R2 upload enabled (bucket: ${r2Bucket})`);

      const CONCURRENCY = 10;
      const total = restricted.length;
      let uploaded = 0;
      let skipped = 0;
      const failed: Array<{ id: string; reason: string }> = [];

      console.log(
        `\n⬆️  Uploading ${total} restricted assets to r2://${r2Bucket} (concurrency=${CONCURRENCY})\n`,
      );

      for (let i = 0; i < restricted.length; i += CONCURRENCY) {
        const batch = restricted.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (asset) => {
            const result = await uploadAsset(asset.id, asset.download);
            const done = uploaded + skipped + failed.length + 1;
            if (result.status === "uploaded") {
              uploaded++;
              process.stdout.write(`[${done}/${total}] ✓ ${asset.id}          \r`);
            } else if (result.status === "skipped") {
              skipped++;
              process.stdout.write(`[${done}/${total}] — ${asset.id} (exists) \r`);
            } else {
              failed.push({ id: asset.id, reason: result.reason ?? "unknown" });
              process.stdout.write(`[${done}/${total}] ✗ ${asset.id}: ${result.reason}\n`);
            }
          }),
        );
      }

      console.log(
        `\n\n📊 Upload complete: uploaded=${uploaded}  skipped=${skipped}  failed=${failed.length}`,
      );

      if (failed.length > 0) {
        console.error("\n❌ Failed uploads:");
        for (const { id, reason } of failed.slice(0, 10)) {
          console.error(`  ${id}: ${reason}`);
        }
        if (failed.length > 10) {
          console.error(`  ... and ${failed.length - 10} more`);
        }
        console.error(`\n⚠️  ${failed.length} assets failed to upload`);
        process.exit(1);
      }

      const accounted = uploaded + skipped;
      if (accounted !== total) {
        console.error(`\n❌ Mismatch: ${accounted} assets accounted for, expected ${total}`);
        process.exit(1);
      }

      console.log(`\n✅ All ${total} restricted assets verified in R2`);
    } else {
      console.log("\n⚠️  Restricted assets found but R2 credentials not set — skipping uploads");
      console.log(
        "   To enable uploads, set: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
      );
      console.log(
        "   Get credentials from: https://dash.cloudflare.com → R2 → Manage R2 API Tokens",
      );
      console.log(
        "   Index will be built with R2 URLs, but files won't be accessible until uploaded.",
      );
    }
  }

  // Build index — Pass 1: resolve URLs + compute raw TF per asset
  type AssetWithTF = Omit<ProcessedAsset, "tokenWeights"> & {
    _tf: Record<string, number>;
    _docLength: number;
  };

  const pass1: AssetWithTF[] = raw.map(({ platform, ...a }) => {
    const cleaned = { ...a, animationClips: cleanClips(a.animationClips) };
    const isRestricted = getAccessMode(platform, accessConfig) === "restricted";
    const withUrl = isRestricted
      ? { ...cleaned, download: `${ASSETS_BASE_URL}/files/${a.id}.glb` }
      : cleaned;
    const { tf, docLength } = buildRawTF(withUrl);
    return { ...withUrl, titleTokens: tokenize(withUrl.title), _tf: tf, _docLength: docLength };
  });

  // Pass 2: compute corpus stats and apply BM25
  const N = pass1.length;
  const avgdl = pass1.reduce((s, a) => s + a._docLength, 0) / N;
  const df: Record<string, number> = {};
  for (const a of pass1) {
    for (const token of Object.keys(a._tf)) {
      df[token] = (df[token] ?? 0) + 1;
    }
  }

  const assets: ProcessedAsset[] = pass1.map(({ _tf, _docLength, ...a }) => ({
    ...a,
    tokenWeights: applyBM25(_tf, _docLength, avgdl, df, N),
  }));

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

  console.log(
    `\n✅ Index built: ${assets.length} assets | ${index.meta.animatedAssets} animated | ${index.meta.totalTokens} tokens`,
  );
  console.log(`📝 ${OUT_FILE}`);
  if (restricted.length > 0) {
    console.log(`🔗 Restricted URL format: ${ASSETS_BASE_URL}/files/{id}.glb`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
