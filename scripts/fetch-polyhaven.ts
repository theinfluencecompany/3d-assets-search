/**
 * Fetch 3D models and HDRIs from Poly Haven's public API.
 * Writes data/sources/polyhaven.json with platform: "polyhaven".
 *
 * Usage:
 *   bun scripts/fetch-polyhaven.ts            # fetch if source file missing
 *   bun scripts/fetch-polyhaven.ts --force    # re-fetch everything
 *
 * No env vars required — Poly Haven API is open access.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "data", "sources", "polyhaven.json");
const API_BASE = "https://api.polyhaven.com";
const CONCURRENCY = 10;
const USER_AGENT = "3d-assets-search";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiAssetEntry {
  name: string;
  type: number; // 0 = hdris, 1 = textures, 2 = models
  categories: string[];
  tags: string[];
  authors: Record<string, string>;
  download_count: number;
  polycount?: number;
  dimensions?: number[];
}

type AssetsResponse = Record<string, ApiAssetEntry>;

interface FileEntry {
  url: string;
  size: number;
  md5: string;
}

// Poly Haven /files response is deeply nested — we only need specific paths.
type FilesResponse = Record<
  string,
  Record<string, Record<string, FileEntry | Record<string, FileEntry>>>
>;

interface SourceAsset {
  id: string;
  title: string;
  creator: string;
  category: string;
  type: "model" | "hdri";
  tags: string[];
  styleTags: string[];
  animated: boolean;
  animationClips: string[];
  license: string;
  triCount: number;
  thumbnail: string;
  download: string;
  sourceUrl: string;
  bounds?: { x: number; y: number; z: number };
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

const defaultHeaders = { "User-Agent": USER_AGENT };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: defaultHeaders });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json() as Promise<T>;
}

// ─── Download URL extraction ──────────────────────────────────────────────────

function extractModelUrl(files: FilesResponse, id: string): string | null {
  // Prefer gltf at 1k resolution
  const gltf = files.gltf as Record<string, Record<string, FileEntry>> | undefined;
  const res1k = gltf?.["1k"];
  if (res1k) {
    // Find the main .gltf file entry
    const gltfEntry = Object.values(res1k).find(
      (entry) =>
        typeof entry === "object" && "url" in entry && (entry as FileEntry).url.endsWith(".gltf"),
    ) as FileEntry | undefined;
    if (gltfEntry) return gltfEntry.url;
  }
  // Fallback: try 2k
  const res2k = gltf?.["2k"];
  if (res2k) {
    const gltfEntry = Object.values(res2k).find(
      (entry) =>
        typeof entry === "object" && "url" in entry && (entry as FileEntry).url.endsWith(".gltf"),
    ) as FileEntry | undefined;
    if (gltfEntry) return gltfEntry.url;
  }
  return null;
}

function extractHdriUrl(files: FilesResponse, _id: string): string | null {
  // Prefer exr at 1k resolution
  const hdri = files.hdri as Record<string, Record<string, FileEntry>> | undefined;
  const res1k = hdri?.["1k"];
  if (res1k) {
    const exrEntry = Object.values(res1k).find(
      (entry) =>
        typeof entry === "object" && "url" in entry && (entry as FileEntry).url.endsWith(".exr"),
    ) as FileEntry | undefined;
    if (exrEntry) return exrEntry.url;
  }
  // Fallback: try 2k
  const res2k = hdri?.["2k"];
  if (res2k) {
    const exrEntry = Object.values(res2k).find(
      (entry) =>
        typeof entry === "object" && "url" in entry && (entry as FileEntry).url.endsWith(".exr"),
    ) as FileEntry | undefined;
    if (exrEntry) return exrEntry.url;
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const force = process.argv.includes("--force");

  if (!force && existsSync(OUT_FILE)) {
    const existing = JSON.parse(readFileSync(OUT_FILE, "utf8")) as { assets?: unknown[] };
    console.log(
      `✅ ${OUT_FILE} already exists (${existing.assets?.length ?? 0} assets). Use --force to refresh.`,
    );
    return;
  }

  // 1. Fetch all models and HDRIs metadata
  console.log("🌐 Fetching Poly Haven asset catalog...");
  const [models, hdris] = await Promise.all([
    fetchJson<AssetsResponse>(`${API_BASE}/assets?t=models`),
    fetchJson<AssetsResponse>(`${API_BASE}/assets?t=hdris`),
  ]);

  const modelIds = Object.keys(models);
  const hdriIds = Object.keys(hdris);
  console.log(`📊 Found ${modelIds.length} models + ${hdriIds.length} HDRIs`);

  // 2. Fetch /files/{id} for each asset to get download URLs
  const allEntries: Array<{ id: string; meta: ApiAssetEntry; assetType: "model" | "hdri" }> = [
    ...modelIds.map((id) => ({ id, meta: models[id], assetType: "model" as const })),
    ...hdriIds.map((id) => ({ id, meta: hdris[id], assetType: "hdri" as const })),
  ];

  const assets: SourceAsset[] = [];
  let done = 0;
  let skipped = 0;

  for (let i = 0; i < allEntries.length; i += CONCURRENCY) {
    const batch = allEntries.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async ({ id, meta, assetType }) => {
        try {
          const files = await fetchJson<FilesResponse>(`${API_BASE}/files/${id}`);
          const downloadUrl =
            assetType === "model" ? extractModelUrl(files, id) : extractHdriUrl(files, id);

          if (!downloadUrl) {
            skipped++;
            done++;
            return;
          }

          const firstAuthor = Object.keys(meta.authors)[0] ?? "Poly Haven";
          const category = meta.categories?.[0] ?? "";

          const asset: SourceAsset = {
            id,
            title: meta.name,
            creator: firstAuthor,
            category,
            type: assetType,
            tags: meta.tags ?? [],
            styleTags: [],
            animated: false,
            animationClips: [],
            license: "CC0",
            triCount: meta.polycount ?? 0,
            thumbnail: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`,
            download: downloadUrl,
            sourceUrl: `https://polyhaven.com/a/${id}`,
          };

          // Add bounds from dimensions (mm) if available
          if (assetType === "model" && meta.dimensions && meta.dimensions.length === 3) {
            asset.bounds = {
              x: meta.dimensions[0] / 1000,
              y: meta.dimensions[1] / 1000,
              z: meta.dimensions[2] / 1000,
            };
          }

          assets.push(asset);
        } catch {
          skipped++;
        }
        done++;
        process.stdout.write(`  [${done}/${allEntries.length}] fetching file info...\r`);
      }),
    );
  }

  console.log(`\n✅ Fetched ${assets.length} assets (${skipped} skipped)`);

  // 3. Write source file
  const modelCount = assets.filter((a) => a.type === "model").length;
  const hdriCount = assets.filter((a) => a.type === "hdri").length;

  writeFileSync(OUT_FILE, JSON.stringify({ platform: "polyhaven", assets }, null, 2));
  console.log(`📝 ${OUT_FILE}`);
  console.log(`   ${modelCount} models + ${hdriCount} HDRIs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
