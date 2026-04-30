import { readFileSync } from "node:fs";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  type AssetType,
  type PrepareStrategy,
  type PreparedAssetEntry,
  type PreparedAssetsManifest,
  PrepareStrategySchema,
} from "../../src/types.js";
import { convertGltfToGlbWithIncludes, convertZipToGlb } from "../lib/gltf-to-glb.js";
import { stableHash } from "../lib/hash.js";
import {
  creatorFromFilename,
  listSourceFiles,
  loadPreparedManifest,
  parseCliArgs,
  PREPARED_MANIFEST_PATH,
  readSourceFile,
  savePreparedManifest,
  SOURCES_CONFIG_PATH,
} from "../lib/runtime.js";

const SourcesConfigSchema = z.object({
  platforms: z.record(
    z.string(),
    z.object({
      creators: z.array(z.string()).optional(),
      prepare: z.object({
        model: z.object({
          strategy: PrepareStrategySchema,
          uploadToR2: z.boolean(),
        }),
        hdri: z.object({
          strategy: PrepareStrategySchema,
          uploadToR2: z.boolean(),
        }),
      }),
    }),
  ),
});

const R2EnvSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  R2_BUCKET: z.string().default("3d-assets"),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
});

const ASSETS_BASE_URL = process.env.ASSETS_BASE_URL ?? "https://mcp.fried.gg";
const PREPARE_VERSION = "v1";
const RETRY_ATTEMPTS = 3;

let r2Client: S3Client | null = null;
let r2Bucket: string | null = null;

function loadAccessConfig() {
  return SourcesConfigSchema.parse(JSON.parse(readFileSync(SOURCES_CONFIG_PATH, "utf8")));
}

function getPreparePolicy(
  platform: string,
  type: AssetType,
  config: z.infer<typeof SourcesConfigSchema>,
) {
  return config.platforms[platform]?.prepare[type] ?? config.platforms["restricted"]!.prepare[type];
}

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

async function existsInR2(key: string): Promise<boolean> {
  if (!r2Client || !r2Bucket) return false;
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

function determineStrategy(configured: PrepareStrategy, download: string): PrepareStrategy {
  if (
    configured === "polyhaven-gltf-pack" &&
    (download.endsWith(".zip") || download.endsWith(".gltf"))
  ) {
    return "polyhaven-gltf-pack";
  }
  return configured;
}

function getPrepareSignature(input: {
  platform: string;
  type: AssetType;
  download: string;
  downloadIncludes?: Record<string, string> | undefined;
  strategy: PrepareStrategy;
}) {
  return stableHash({ ...input, prepareVersion: PREPARE_VERSION });
}

async function buildPreparedBody(asset: {
  download: string;
  downloadIncludes?: Record<string, string> | undefined;
  strategy: PrepareStrategy;
}): Promise<Uint8Array> {
  if (asset.strategy === "upload-glb") {
    const response = await fetch(asset.download);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  if (asset.strategy === "polyhaven-gltf-pack") {
    if (asset.download.endsWith(".zip")) {
      return convertZipToGlb(asset.download);
    }
    if (asset.download.endsWith(".gltf")) {
      return convertGltfToGlbWithIncludes(asset.download, asset.downloadIncludes);
    }
  }
  throw new Error(`unsupported prepare strategy for ${asset.download}`);
}

async function uploadPreparedGlb(assetId: string, body: Uint8Array): Promise<void> {
  const key = `${assetId}.glb`;
  await r2Client!.send(
    new PutObjectCommand({
      Bucket: r2Bucket!,
      Key: key,
      Body: body,
      ContentType: "model/gltf-binary",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

function shouldRetryPrepareError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return [
    "socket connection was closed unexpectedly",
    "econnreset",
    "timedout",
    "timeout",
    "network",
    "503",
    "502",
    "500",
    "429",
    "rate limit",
    "temporarily unavailable",
  ].some((token) => message.includes(token));
}

async function withPrepareRetries<T>(label: string, task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (attempt === RETRY_ATTEMPTS || !shouldRetryPrepareError(err)) {
        throw err;
      }
      const delayMs = 1000 * 2 ** (attempt - 1);
      process.stdout.write(
        `    ↺ ${label} retry ${attempt}/${RETRY_ATTEMPTS - 1} in ${delayMs}ms\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  const { force, retryFailed, target } = parseCliArgs(process.argv.slice(2));
  const sourceFiles = listSourceFiles(target);
  const accessConfig = loadAccessConfig();
  const manifest = loadPreparedManifest();
  const r2Enabled = initR2Client();
  const liveAssetIds = new Set<string>();

  console.log(`📦 Prepare manifest: ${PREPARED_MANIFEST_PATH}`);
  if (retryFailed) {
    console.log("🔁 Mode: retry failed assets only");
  }
  if (!r2Enabled) {
    console.log("⚠️  R2 credentials not configured. Passthrough assets will still be recorded.");
  }

  for (const file of sourceFiles) {
    const source = readSourceFile(file);
    const creator = creatorFromFilename(file);
    void creator;
    console.log(`\n📂 ${file} (${source.platform})`);

    for (const asset of source.assets) {
      liveAssetIds.add(asset.id);
      const policy = getPreparePolicy(source.platform, asset.type, accessConfig);
      const strategy = determineStrategy(policy.strategy, asset.download);
      const prepareSignature = getPrepareSignature({
        platform: source.platform,
        type: asset.type,
        download: asset.download,
        downloadIncludes: asset.downloadIncludes,
        strategy,
      });
      const existing = manifest.assets[asset.id];

      if (retryFailed && existing?.status !== "failed") {
        continue;
      }

      if (
        !force &&
        existing &&
        existing.prepareSignature === prepareSignature &&
        ["uploaded", "passthrough", "skipped"].includes(existing.status)
      ) {
        process.stdout.write(`  — ${asset.id} (${existing.status})\n`);
        continue;
      }

      const baseEntry: Omit<PreparedAssetEntry, "status" | "preparedUrl" | "preparedFormat"> = {
        assetId: asset.id,
        sourceFile: file,
        sourcePlatform: source.platform,
        sourceType: asset.type,
        strategy,
        prepareSignature,
        sourceDownload: asset.download,
      };

      if (!policy.uploadToR2) {
        manifest.assets[asset.id] = {
          ...baseEntry,
          status: asset.type === "hdri" ? "skipped" : "passthrough",
          preparedFormat: "source",
          preparedUrl: asset.download,
          preparedKey: null,
          preparedAt: new Date().toISOString(),
        };
        process.stdout.write(
          `  ✓ ${asset.id} (${asset.type === "hdri" ? "skipped" : "passthrough"})\n`,
        );
        continue;
      }

      if (!r2Enabled) {
        manifest.assets[asset.id] = {
          ...baseEntry,
          status: "failed",
          preparedFormat: "glb",
          preparedUrl: `${ASSETS_BASE_URL}/files/${asset.id}.glb`,
          preparedKey: `${asset.id}.glb`,
        };
        process.stdout.write(`  ✗ ${asset.id} (missing R2 credentials)\n`);
        continue;
      }

      try {
        const key = `${asset.id}.glb`;
        if (!(await existsInR2(key)) || force) {
          await withPrepareRetries(asset.id, async () => {
            const body = await buildPreparedBody({
              download: asset.download,
              downloadIncludes: asset.downloadIncludes,
              strategy,
            });
            await uploadPreparedGlb(asset.id, body);
          });
        }
        manifest.assets[asset.id] = {
          ...baseEntry,
          status: "uploaded",
          preparedFormat: "glb",
          preparedUrl: `${ASSETS_BASE_URL}/files/${asset.id}.glb`,
          preparedKey: key,
          preparedAt: new Date().toISOString(),
        };
        process.stdout.write(`  ✓ ${asset.id} (uploaded)\n`);
      } catch {
        manifest.assets[asset.id] = {
          ...baseEntry,
          status: "failed",
          preparedFormat: "glb",
          preparedUrl: `${ASSETS_BASE_URL}/files/${asset.id}.glb`,
          preparedKey: `${asset.id}.glb`,
        };
        process.stdout.write(`  ✗ ${asset.id} (failed)\n`);
      }
    }
  }

  for (const [assetId, entry] of Object.entries(manifest.assets)) {
    if (sourceFiles.includes(entry.sourceFile) && !liveAssetIds.has(assetId)) {
      delete manifest.assets[assetId];
    }
  }

  manifest.updatedAt = new Date().toISOString();
  savePreparedManifest(manifest as PreparedAssetsManifest);
  console.log(`\n✅ Prepared assets updated: ${PREPARED_MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
