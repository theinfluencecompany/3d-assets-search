/**
 * Build script — generates the optimized search index from raw source files.
 * Also uploads GLB assets to Cloudflare R2 and rewrites download URLs to R2.
 *
 * Usage: bun run preprocess   (or automatically via `bun run pipeline`)
 *
 * Input:  data/sources/*.json  (one file per creator — filename = creator name)
 * Output: data/asset-search-preprocessed.json
 *
 * Adding a new asset source: drop data/sources/<creator>.json and re-run.
 * Example: data/sources/kenney.json → creator "Kenney"
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
const OUT_FILE = join(ROOT, "data", "asset-search-preprocessed.json");

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

const RawFileIndexSchema = z.object({ assets: z.array(RawFileAssetSchema) });

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

function loadRawAssets(file: string, creator: string): Array<RawFileAsset & { creator: string }> {
  const parsed = RawFileIndexSchema.parse(
    JSON.parse(readFileSync(join(SOURCES_DIR, file), "utf8")),
  );
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
    for (const t of tokenize(clip)) {
      weights[t] = Math.max(weights[t] ?? 0, FIELD_WEIGHTS.clips);
    }
    const fullToken = clip.toLowerCase().replace(/_/g, "");
    weights[fullToken] = Math.max(weights[fullToken] ?? 0, FIELD_WEIGHTS.clips);
  }

  return weights;
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

  const r2Enabled = initR2Client();
  if (r2Enabled) {
    console.log(`☁️  R2 upload enabled (bucket: ${r2Bucket})`);
  } else {
    console.log("⚠️  R2 credentials not found — skipping uploads");
    console.log("   To enable uploads, set these environment variables:");
    console.log("   - CLOUDFLARE_ACCOUNT_ID");
    console.log("   - R2_ACCESS_KEY_ID");
    console.log("   - R2_SECRET_ACCESS_KEY");
    console.log("");
    console.log("   Get credentials from: https://dash.cloudflare.com → R2 → Manage R2 API Tokens");
  }

  // Load all raw assets from source files
  const raw = sourceFiles.flatMap((file) => {
    const creator = creatorFromFilename(file);
    console.log(`📂 sources/${file} → creator: ${creator}`);
    return loadRawAssets(file, creator);
  });

  console.log(`\n📊 Found ${raw.length} assets to process`);

  // Upload assets to R2 (if enabled) with concurrency limit
  if (r2Enabled) {
    const CONCURRENCY = 10;
    const total = raw.length;
    let uploaded = 0;
    let skipped = 0;
    const failed: Array<{ id: string; reason: string }> = [];

    console.log(`\n⬆️  Uploading ${total} assets to r2://${r2Bucket} (concurrency=${CONCURRENCY})`);
    console.log("   (This may take a few minutes for 1261 assets...)\n");

    for (let i = 0; i < raw.length; i += CONCURRENCY) {
      const batch = raw.slice(i, i + CONCURRENCY);
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
        // Show first 10
        console.error(`  ${id}: ${reason}`);
      }
      if (failed.length > 10) {
        console.error(`  ... and ${failed.length - 10} more`);
      }
      console.error(`\n⚠️  ${failed.length} assets failed to upload`);
      process.exit(1);
    }

    // Verify all assets are accounted for
    const accounted = uploaded + skipped;
    if (accounted !== total) {
      console.error(`\n❌ Mismatch: ${accounted} assets accounted for, expected ${total}`);
      process.exit(1);
    }

    console.log(`\n✅ All ${total} assets verified in R2`);
  } else {
    console.log("\n⚠️  Skipping R2 upload (no credentials)");
    console.log("   The index will still be built with R2 URLs, but files won't be uploaded.");
    console.log("   Run this again with credentials to upload.");
  }

  // Build index with R2 URLs
  const assets: ProcessedAsset[] = raw.map((a) => {
    const cleaned = { ...a, animationClips: cleanClips(a.animationClips) };
    const withR2Url = {
      ...cleaned,
      download: `${ASSETS_BASE_URL}/files/${a.id}.glb`, // Public URL format
    };
    return { ...withR2Url, tokenWeights: buildTokenWeights(withR2Url) };
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

  console.log(
    `\n✅ Index built: ${assets.length} assets | ${index.meta.animatedAssets} animated | ${index.meta.totalTokens} tokens`,
  );
  console.log(`📝 ${OUT_FILE}`);
  console.log(`🔗 Public URL format: ${ASSETS_BASE_URL}/files/{id}.glb`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
