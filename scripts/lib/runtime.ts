import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoundsManifestSchema,
  type BoundsManifest,
  PreparedAssetsManifestSchema,
  type PreparedAssetsManifest,
  RawAssetSchema,
  TaggedAssetsManifestSchema,
  type TaggedAssetsManifest,
} from "../../src/types.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const SOURCES_DIR = join(DATA_DIR, "sources");
export const MANIFESTS_DIR = join(DATA_DIR, "manifests");
export const PREPARED_MANIFEST_PATH = join(MANIFESTS_DIR, "prepared-assets.json");
export const BOUNDS_MANIFEST_PATH = join(MANIFESTS_DIR, "bounds.json");
export const TAGGED_MANIFEST_PATH = join(MANIFESTS_DIR, "tagged-assets.json");
export const PREPROCESSED_INDEX_PATH = join(DATA_DIR, "asset-search-preprocessed.json");
export const SOURCES_CONFIG_PATH = join(DATA_DIR, "sources.config.json");

export type SourceAsset = ReturnType<typeof RawAssetSchema.parse>;

export interface SourceFile {
  platform: string;
  assets: SourceAsset[];
}

export interface ParsedCliArgs {
  force: boolean;
  retryFailed: boolean;
  target?: string | undefined;
}

function parseSourceFile(content: string): SourceFile {
  const parsed = JSON.parse(content) as { platform?: unknown; assets?: unknown[] };
  return {
    platform: typeof parsed.platform === "string" ? parsed.platform : "restricted",
    assets: (parsed.assets ?? []).map((asset) => RawAssetSchema.parse(asset)),
  };
}

export function ensureManifestsDir(): void {
  mkdirSync(MANIFESTS_DIR, { recursive: true });
}

export function parseCliArgs(args: string[]): ParsedCliArgs {
  const force = args.includes("--force");
  const retryFailed = args.includes("--retry-failed") || args.includes("--try-failed");
  const target = args.find((arg) => !arg.startsWith("--"));
  return { force, retryFailed, target };
}

export function normalizeSourceName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

export function listSourceFiles(target?: string): string[] {
  const files = existsSync(SOURCES_DIR)
    ? readdirSync(SOURCES_DIR)
        .filter((file) => file.endsWith(".json"))
        .sort()
    : [];
  if (!target) return files;
  const normalized = normalizeSourceName(target);
  const matched = files.filter((file) => basename(file, ".json") === normalized);
  if (matched.length === 0) {
    throw new Error(`Unknown source: ${target}`);
  }
  return matched;
}

export function readSourceFile(file: string): SourceFile {
  return parseSourceFile(readFileSync(join(SOURCES_DIR, file), "utf8"));
}

export function creatorFromFilename(file: string): string {
  const stem = basename(file, ".json");
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

export function loadPreparedManifest(): PreparedAssetsManifest {
  if (!existsSync(PREPARED_MANIFEST_PATH)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), assets: {} };
  }
  return PreparedAssetsManifestSchema.parse(
    JSON.parse(readFileSync(PREPARED_MANIFEST_PATH, "utf8")),
  );
}

export function savePreparedManifest(manifest: PreparedAssetsManifest): void {
  ensureManifestsDir();
  writeFileSync(PREPARED_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

export function loadBoundsManifest(): BoundsManifest {
  if (!existsSync(BOUNDS_MANIFEST_PATH)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), assets: {} };
  }
  return BoundsManifestSchema.parse(JSON.parse(readFileSync(BOUNDS_MANIFEST_PATH, "utf8")));
}

export function saveBoundsManifest(manifest: BoundsManifest): void {
  ensureManifestsDir();
  writeFileSync(BOUNDS_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

export function loadTaggedManifest(): TaggedAssetsManifest {
  if (!existsSync(TAGGED_MANIFEST_PATH)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), assets: {} };
  }
  return TaggedAssetsManifestSchema.parse(JSON.parse(readFileSync(TAGGED_MANIFEST_PATH, "utf8")));
}

export function saveTaggedManifest(manifest: TaggedAssetsManifest): void {
  ensureManifestsDir();
  writeFileSync(TAGGED_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}
