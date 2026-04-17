/**
 * Extract AABB bounds from GLB files for all assets in source JSONs.
 * Reads the GLB JSON chunk via HTTP Range requests (same technique as animation clip extraction).
 * Results are cached — assets with existing bounds are skipped.
 *
 * Usage:
 *   bun scripts/extract-bounds.ts                     # process all creators
 *   bun scripts/extract-bounds.ts <CreatorName>       # one creator only
 *   bun scripts/extract-bounds.ts --force             # re-extract all
 *   bun scripts/extract-bounds.ts --force Quaternius  # re-extract one creator
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_DIR = join(ROOT, "data", "sources");
const SOURCES_CONFIG_FILE = join(ROOT, "data", "sources.config.json");
const CONCURRENCY = 10;

// ─── Config ────────────────────────────────────────────────────────────────────

interface SourcesConfig {
  platforms: Record<string, { access: string; creators?: string[] }>;
}

function loadConfig(): SourcesConfig {
  return JSON.parse(readFileSync(SOURCES_CONFIG_FILE, "utf8")) as SourcesConfig;
}

function allCreators(config: SourcesConfig): string[] {
  return Object.values(config.platforms).flatMap((p) => p.creators ?? []);
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Bounds {
  x: number;
  y: number;
  z: number;
}

interface SourceAsset {
  id: string;
  title: string;
  download: string;
  bounds?: Bounds;
  [key: string]: unknown;
}

interface SourceFile {
  platform: string;
  assets: SourceAsset[];
}

// ─── GLB / GLTF parsing ────────────────────────────────────────────────────────

interface GltfJson {
  accessors?: Array<{
    min?: number[];
    max?: number[];
    type?: string;
  }>;
  meshes?: Array<{
    primitives: Array<{
      attributes: Record<string, number>;
    }>;
  }>;
}

async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = res.headers.get("Retry-After");
      const delay = retryAfter ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    return res;
  }
  throw new Error("unreachable");
}

function computeBoundsFromGltf(gltf: GltfJson): Bounds | undefined {
  // Collect all accessor indices referenced by mesh POSITION attributes
  const posIndices = new Set<number>();
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const idx = prim.attributes["POSITION"];
      if (idx !== undefined) posIndices.add(idx);
    }
  }
  if (posIndices.size === 0) return undefined;

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (const idx of posIndices) {
    const acc = gltf.accessors?.[idx];
    if (!acc?.min || !acc?.max || acc.type !== "VEC3") continue;
    const [amin0, amin1, amin2] = acc.min;
    const [amax0, amax1, amax2] = acc.max;
    if (amin0 === undefined || amin1 === undefined || amin2 === undefined) continue;
    if (amax0 === undefined || amax1 === undefined || amax2 === undefined) continue;
    if (amin0 < minX) minX = amin0;
    if (amin1 < minY) minY = amin1;
    if (amin2 < minZ) minZ = amin2;
    if (amax0 > maxX) maxX = amax0;
    if (amax1 > maxY) maxY = amax1;
    if (amax2 > maxZ) maxZ = amax2;
  }

  if (!isFinite(minX)) return undefined;

  return {
    x: parseFloat((maxX - minX).toFixed(3)),
    y: parseFloat((maxY - minY).toFixed(3)),
    z: parseFloat((maxZ - minZ).toFixed(3)),
  };
}

async function extractBounds(downloadUrl: string): Promise<Bounds | undefined> {
  try {
    // GLB layout: 12-byte header | 4-byte JSON chunk length | 4-byte chunk type | JSON data
    const headerRes = await fetchWithRetry(downloadUrl, { headers: { Range: "bytes=0-19" } });
    if (!headerRes.ok && headerRes.status !== 206) return undefined;

    const view = new DataView(await headerRes.arrayBuffer());
    const jsonChunkLength = view.getUint32(12, /* little-endian */ true);

    const jsonRes = await fetchWithRetry(downloadUrl, {
      headers: { Range: `bytes=20-${20 + jsonChunkLength - 1}` },
    });
    if (!jsonRes.ok && jsonRes.status !== 206) return undefined;

    const gltf = JSON.parse(new TextDecoder().decode(await jsonRes.arrayBuffer())) as GltfJson;
    return computeBoundsFromGltf(gltf);
  } catch {
    return undefined;
  }
}

// ─── Process one creator ────────────────────────────────────────────────────────

async function extractCreator(creatorFile: string, force: boolean): Promise<void> {
  const filePath = join(SOURCES_DIR, creatorFile);
  if (!existsSync(filePath)) {
    console.log(`⚠️  ${creatorFile} not found — skipping`);
    return;
  }

  const data = JSON.parse(readFileSync(filePath, "utf8")) as SourceFile;
  // Skip HDRIs — they have no geometry
  const models = data.assets.filter((a) => (a as { type?: string }).type !== "hdri");
  const toProcess = force ? models : models.filter((a) => !a.bounds);

  if (toProcess.length === 0) {
    console.log(`✅ ${creatorFile}: all ${data.assets.length} assets already have bounds`);
    return;
  }

  console.log(
    `\n📐 ${creatorFile}: extracting bounds for ${toProcess.length}/${data.assets.length} assets...`,
  );

  const boundsMap = new Map<string, Bounds | null>(
    data.assets.map((a) => [a.id, a.bounds ?? null]),
  );

  let done = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (asset) => {
        const bounds = await extractBounds(asset.download);
        boundsMap.set(asset.id, bounds ?? null);
        if (!bounds) failed++;
        done++;
        process.stdout.write(`  [${done}/${toProcess.length}] ${asset.title}   \r`);
      }),
    );
  }

  const updated: SourceFile = {
    ...data,
    assets: data.assets.map((a) => {
      const b = boundsMap.get(a.id);
      return b ? { ...a, bounds: b } : a;
    }),
  };
  writeFileSync(filePath, JSON.stringify(updated, null, 2));

  const withBounds = updated.assets.filter((a) => a.bounds).length;
  console.log(
    `\n✅ ${creatorFile}: ${withBounds}/${data.assets.length} have bounds${failed > 0 ? ` (${failed} failed/no-mesh)` : ""}`,
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const creatorArg = args.find((a) => a !== "--force");

  const config = loadConfig();

  const creators = creatorArg ? [creatorArg] : allCreators(config);
  if (creators.length === 0) {
    console.log("No creators in sources.config.json");
    return;
  }

  for (const creator of creators) {
    await extractCreator(`${creator.toLowerCase().replace(/\s+/g, "-")}.json`, force);
  }

  console.log("\n🎉 Done. Run `bun run preprocess` to rebuild the index.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
