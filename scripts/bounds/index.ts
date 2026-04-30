import type { Bounds, BoundsManifest } from "../../src/types.js";
import { stableHash } from "../lib/hash.js";
import {
  listSourceFiles,
  loadBoundsManifest,
  loadPreparedManifest,
  parseCliArgs,
  readSourceFile,
  saveBoundsManifest,
} from "../lib/runtime.js";

const BOUNDS_VERSION = "v1";
const CONCURRENCY = 10;

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

function computeBoundsFromGltf(gltf: GltfJson): Bounds | undefined {
  const posIndices = new Set<number>();
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const idx = prim.attributes["POSITION"];
      if (idx !== undefined) posIndices.add(idx);
    }
  }
  if (posIndices.size === 0) return undefined;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const idx of posIndices) {
    const acc = gltf.accessors?.[idx];
    if (!acc?.min || !acc?.max || acc.type !== "VEC3") continue;
    const [amin0, amin1, amin2] = acc.min;
    const [amax0, amax1, amax2] = acc.max;
    if (
      amin0 === undefined ||
      amin1 === undefined ||
      amin2 === undefined ||
      amax0 === undefined ||
      amax1 === undefined ||
      amax2 === undefined
    ) {
      continue;
    }
    minX = Math.min(minX, amin0);
    minY = Math.min(minY, amin1);
    minZ = Math.min(minZ, amin2);
    maxX = Math.max(maxX, amax0);
    maxY = Math.max(maxY, amax1);
    maxZ = Math.max(maxZ, amax2);
  }

  if (!isFinite(minX)) return undefined;
  return {
    x: parseFloat((maxX - minX).toFixed(3)),
    y: parseFloat((maxY - minY).toFixed(3)),
    z: parseFloat((maxZ - minZ).toFixed(3)),
  };
}

async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw new Error("unreachable");
}

async function extractBounds(downloadUrl: string): Promise<Bounds | undefined> {
  const headerRes = await fetchWithRetry(downloadUrl, { headers: { Range: "bytes=0-19" } });
  if (!headerRes.ok && headerRes.status !== 206) return undefined;

  const view = new DataView(await headerRes.arrayBuffer());
  const jsonChunkLength = view.getUint32(12, true);
  const jsonRes = await fetchWithRetry(downloadUrl, {
    headers: { Range: `bytes=20-${20 + jsonChunkLength - 1}` },
  });
  if (!jsonRes.ok && jsonRes.status !== 206) return undefined;

  const gltf = JSON.parse(new TextDecoder().decode(await jsonRes.arrayBuffer())) as GltfJson;
  return computeBoundsFromGltf(gltf);
}

async function main() {
  const { force, target } = parseCliArgs(process.argv.slice(2));
  const sourceFiles = listSourceFiles(target);
  const prepared = loadPreparedManifest();
  const boundsManifest = loadBoundsManifest();
  const liveAssetIds = new Set<string>();

  for (const file of sourceFiles) {
    const source = readSourceFile(file);
    console.log(`\n📐 ${file}`);
    const models = source.assets.filter((asset) => asset.type === "model");
    let done = 0;

    for (let i = 0; i < models.length; i += CONCURRENCY) {
      const batch = models.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (asset) => {
          liveAssetIds.add(asset.id);
          const preparedEntry = prepared.assets[asset.id];
          const boundsSignature = stableHash({
            preparedUrl: preparedEntry?.preparedUrl ?? null,
            boundsVersion: BOUNDS_VERSION,
          });
          const existing = boundsManifest.assets[asset.id];

          if (
            !force &&
            existing &&
            existing.boundsSignature === boundsSignature &&
            ["computed", "skipped"].includes(existing.status)
          ) {
            done++;
            process.stdout.write(`  [${done}/${models.length}] — ${asset.id}\r`);
            return;
          }

          if (!preparedEntry || preparedEntry.status === "failed") {
            boundsManifest.assets[asset.id] = {
              assetId: asset.id,
              sourceFile: file,
              boundsSignature,
              status: "failed",
              error: "prepared model unavailable",
            };
            done++;
            process.stdout.write(`  [${done}/${models.length}] ✗ ${asset.id}\r`);
            return;
          }

          if (!preparedEntry.preparedUrl.endsWith(".glb")) {
            boundsManifest.assets[asset.id] = {
              assetId: asset.id,
              sourceFile: file,
              boundsSignature,
              status: "skipped",
              error: "prepared URL is not a GLB",
            };
            done++;
            process.stdout.write(`  [${done}/${models.length}] — ${asset.id}\r`);
            return;
          }

          try {
            const bounds = await extractBounds(preparedEntry.preparedUrl);
            boundsManifest.assets[asset.id] = {
              assetId: asset.id,
              sourceFile: file,
              boundsSignature,
              status: bounds ? "computed" : "failed",
              ...(bounds ? { bounds } : {}),
              computedAt: new Date().toISOString(),
              error: bounds ? null : "could not compute bounds",
            };
          } catch (err) {
            boundsManifest.assets[asset.id] = {
              assetId: asset.id,
              sourceFile: file,
              boundsSignature,
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
            };
          }
          done++;
          process.stdout.write(`  [${done}/${models.length}] ✓ ${asset.id}\r`);
        }),
      );
    }
    console.log("");
  }

  for (const [assetId, entry] of Object.entries(boundsManifest.assets)) {
    if (sourceFiles.includes(entry.sourceFile) && !liveAssetIds.has(assetId)) {
      delete boundsManifest.assets[assetId];
    }
  }

  boundsManifest.updatedAt = new Date().toISOString();
  saveBoundsManifest(boundsManifest as BoundsManifest);
  console.log("\n✅ Bounds manifest updated");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
