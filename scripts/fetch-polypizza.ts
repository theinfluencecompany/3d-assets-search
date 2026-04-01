/**
 * Fetch assets from poly.pizza for creators listed in data/sources.config.json.
 * Animation clips are extracted from GLB files via HTTP Range requests.
 * Existing source files are used as a cache to skip already-fetched clips.
 *
 * Usage:
 *   bun scripts/fetch-polypizza.ts              # fetch all missing creators from config
 *   bun scripts/fetch-polypizza.ts <Username>   # fetch/refresh one specific creator
 *
 * Env: POLY_PIZZA_API_KEY (required)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_DIR = join(ROOT, "data", "sources");
const SOURCES_CONFIG_FILE = join(ROOT, "data", "sources.config.json");
const API_BASE = "https://api.poly.pizza/v1.1";
const CONCURRENCY = 10;

// ─── Config ────────────────────────────────────────────────────────────────────

interface SourcesConfig {
  platforms: Record<string, { access: string; creators?: string[] }>;
}

function loadConfig(): SourcesConfig {
  return JSON.parse(readFileSync(SOURCES_CONFIG_FILE, "utf8")) as SourcesConfig;
}

function polyPizzaCreators(config: SourcesConfig): string[] {
  return config.platforms["poly.pizza"]?.creators ?? [];
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ApiModel {
  ID: string;
  Title: string;
  Category: string;
  Tags: string[] | null;
  Animated: boolean;
  Licence: string;
  "Tri Count": number;
  Thumbnail: string;
  Download: string;
}

interface SourceAsset {
  id: string;
  title: string;
  category: string;
  tags: string[];
  styleTags: string[];
  animated: boolean;
  animationClips: string[];
  license: string;
  triCount: number;
  thumbnail: string;
  download: string;
  polyPizzaUrl: string;
}

// ─── Retry fetch ───────────────────────────────────────────────────────────────

async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = 1000 * 2 ** attempt;
      process.stdout.write(`  retrying in ${delay}ms (${err})...\r`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

// ─── API ───────────────────────────────────────────────────────────────────────

interface UserResponse {
  models?: ApiModel[];
  lists?: string[];
}

interface ListResponse {
  Name: string;
  Models: ApiModel[];
}

async function fetchAllModels(username: string, apiKey: string): Promise<ApiModel[]> {
  const headers = { "x-auth-token": apiKey };
  const seen = new Set<string>();
  const all: ApiModel[] = [];

  function addModels(models: ApiModel[]) {
    for (const m of models) {
      if (!seen.has(m.ID)) {
        seen.add(m.ID);
        all.push(m);
      }
    }
  }

  // 1. Paginate direct user models; collect list IDs from first page
  let listIds: string[] = [];
  let offset = 0;
  const limit = 32;
  while (true) {
    const res = await fetchWithRetry(
      `${API_BASE}/user/${username}?limit=${limit}&offset=${offset}`,
      { headers },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(`API ${res.status}: ${JSON.stringify(body)}`);
    }
    const data = (await res.json()) as UserResponse;
    if (offset === 0) listIds = data.lists ?? [];
    const models = data.models ?? [];
    const before = all.length;
    addModels(models);
    process.stdout.write(`  fetched ${all.length} direct...\r`);
    if (models.length < limit || all.length === before) break;
    offset += limit;
  }

  // 2. Fetch all lists (no pagination — returns all models at once)
  if (listIds.length > 0) {
    process.stdout.write(`\n`);
    for (const listId of listIds) {
      const res = await fetchWithRetry(`${API_BASE}/list/${listId}`, { headers });
      if (!res.ok) continue;
      const data = (await res.json()) as ListResponse;
      addModels(data.Models ?? []);
      process.stdout.write(`  fetched ${all.length} (+list "${data.Name}")...\r`);
    }
  }

  return all;
}

// ─── GLB Range extraction ──────────────────────────────────────────────────────

async function fetchAnimationClips(downloadUrl: string): Promise<string[]> {
  try {
    // GLB layout: 12-byte header | 4-byte JSON chunk length | 4-byte chunk type | JSON data
    const headerRes = await fetchWithRetry(downloadUrl, { headers: { Range: "bytes=0-19" } });
    if (!headerRes.ok && headerRes.status !== 206) return [];

    const view = new DataView(await headerRes.arrayBuffer());
    const jsonChunkLength = view.getUint32(12, /* little-endian */ true);

    const jsonRes = await fetchWithRetry(downloadUrl, {
      headers: { Range: `bytes=20-${20 + jsonChunkLength - 1}` },
    });
    if (!jsonRes.ok && jsonRes.status !== 206) return [];

    const gltf = JSON.parse(new TextDecoder().decode(await jsonRes.arrayBuffer())) as {
      animations?: { name: string }[];
    };
    return (gltf.animations ?? []).map((a) => a.name);
  } catch {
    return [];
  }
}

// ─── Old API fallback ─────────────────────────────────────────────────────────

interface OldApiModel {
  publicID: string;
  title: string;
  previewUrl: string;
  url: string;
  licence: string;
}

interface OldApiResponse {
  models?: OldApiModel[];
  lists?: string[];
}

async function fetchAllModelsOldApi(username: string, apiKey: string): Promise<SourceAsset[]> {
  const headers = { "x-auth-token": apiKey };
  const res = await fetchWithRetry(`https://poly.pizza/api/user/${username}`, { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(`Old API ${res.status}: ${JSON.stringify(body)}`);
  }
  const data = (await res.json()) as OldApiResponse;
  const models = data.models ?? [];

  return models.map((m) => ({
    id: m.publicID,
    title: m.title,
    category: "",
    tags: [],
    styleTags: [],
    animated: false, // unknown — will be set to true if GLB contains animations
    animationClips: [],
    license: m.licence,
    triCount: 0,
    thumbnail: m.previewUrl,
    download: m.previewUrl.replace(/\.webp$/, ".glb"),
    polyPizzaUrl: `https://poly.pizza${m.url}`,
  }));
}

// ─── Single creator fetch ──────────────────────────────────────────────────────

async function fetchAndExtractClips(
  assets: SourceAsset[],
  cachedClips: Map<string, string[]>,
  cachedStyleTags: Map<string, string[]>,
): Promise<SourceAsset[]> {
  // For v1.1: only fetch clips for assets marked Animated
  // For old API: fetch clips for ALL assets (Animated field unknown), use result to set animated
  const needsGlb = assets.filter((a) => !cachedClips.has(a.id));

  if (needsGlb.length === 0) {
    return assets.map((a) => ({
      ...a,
      styleTags: cachedStyleTags.get(a.id) ?? a.styleTags,
      animationClips: cachedClips.get(a.id) ?? a.animationClips,
    }));
  }

  console.log(`\n🎬 Extracting clips (concurrency=${CONCURRENCY})...`);
  const clips = new Map<string, string[]>(cachedClips);
  let done = 0;

  for (let i = 0; i < needsGlb.length; i += CONCURRENCY) {
    const batch = needsGlb.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (asset) => {
        const extracted = await fetchAnimationClips(asset.download);
        clips.set(asset.id, extracted);
        done++;
        process.stdout.write(
          `  [${done}/${needsGlb.length}] ${asset.title}: ${extracted.length} clips   \r`,
        );
      }),
    );
  }
  console.log(`\n✅ Extraction done`);

  return assets.map((a) => {
    const animationClips = clips.get(a.id) ?? a.animationClips;
    return {
      ...a,
      styleTags: cachedStyleTags.get(a.id) ?? a.styleTags,
      animated: a.animated || animationClips.length > 0,
      animationClips,
    };
  });
}

async function fetchCreator(username: string, apiKey: string): Promise<void> {
  const outFile = join(SOURCES_DIR, `${username.toLowerCase().replace(/\s+/g, "-")}.json`);

  // Load existing clips as cache to avoid re-fetching
  const cachedClips = new Map<string, string[]>();
  const cachedStyleTags = new Map<string, string[]>();
  if (existsSync(outFile)) {
    const existing = JSON.parse(readFileSync(outFile, "utf8")) as { assets?: SourceAsset[] };
    for (const asset of existing.assets ?? []) {
      if (asset.animationClips.length > 0) cachedClips.set(asset.id, asset.animationClips);
      if (asset.styleTags?.length > 0) cachedStyleTags.set(asset.id, asset.styleTags);
    }
    console.log(
      `📦 Cache: ${cachedClips.size} assets with clips, ${cachedStyleTags.size} with style tags`,
    );
  }

  console.log(`🌐 Fetching models for ${username}...`);

  // Try v1.1 API first, fall back to old API on failure
  let assets: SourceAsset[];
  try {
    let models = await fetchAllModels(username, apiKey);
    // If v1.1 returned only one page, check old API — migrated accounts may be capped at 32
    if (models.length <= 32) {
      try {
        const oldAssets = await fetchAllModelsOldApi(username, apiKey);
        if (oldAssets.length > models.length) {
          console.log(
            `\n⚠️  v1.1 returned only ${models.length} models; old API has ${oldAssets.length} — using old API`,
          );
          const rawAssets = oldAssets.map((a) => ({
            ...a,
            styleTags: cachedStyleTags.get(a.id) ?? [],
          }));
          assets = await fetchAndExtractClips(rawAssets, cachedClips, cachedStyleTags);
          writeFileSync(outFile, JSON.stringify({ platform: "poly.pizza", assets }, null, 2));
          const animatedCount = assets.filter((a) => a.animated).length;
          const withClips = assets.filter((a) => a.animationClips.length > 0).length;
          console.log(`\n📝 ${outFile}`);
          console.log(
            `✅ ${assets.length} assets | ${animatedCount} animated | ${withClips} with clips`,
          );
          return;
        }
      } catch {
        // old API also failed — continue with v1.1 results
      }
    }
    console.log(`\n✅ ${models.length} models (v1.1)`);

    const animatedModels = models.filter((m) => m.Animated);
    const needsGlb = animatedModels.filter((m) => !cachedClips.has(m.ID));
    console.log(
      `   ${animatedModels.length} animated | ${needsGlb.length} need GLB extraction | ${animatedModels.length - needsGlb.length} cached`,
    );

    const clips = new Map<string, string[]>(cachedClips);
    if (needsGlb.length > 0) {
      console.log(`\n🎬 Extracting clips (concurrency=${CONCURRENCY})...`);
      let done = 0;
      for (let i = 0; i < needsGlb.length; i += CONCURRENCY) {
        const batch = needsGlb.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (model) => {
            const extracted = await fetchAnimationClips(model.Download);
            clips.set(model.ID, extracted);
            done++;
            process.stdout.write(
              `  [${done}/${needsGlb.length}] ${model.Title}: ${extracted.length} clips   \r`,
            );
          }),
        );
      }
      console.log(`\n✅ Extraction done`);
    }

    assets = models.map((m) => ({
      id: m.ID,
      title: m.Title,
      category: m.Category,
      tags: m.Tags ?? [],
      styleTags: cachedStyleTags.get(m.ID) ?? [],
      animated: m.Animated,
      animationClips: clips.get(m.ID) ?? [],
      license: m.Licence,
      triCount: m["Tri Count"],
      thumbnail: m.Thumbnail,
      download: m.Download,
      polyPizzaUrl: `https://poly.pizza/m/${m.ID}`,
    }));
  } catch (v1Err) {
    console.warn(
      `\n⚠️  v1.1 API failed (${v1Err instanceof Error ? v1Err.message : v1Err}), trying old API...`,
    );
    try {
      const rawAssets = await fetchAllModelsOldApi(username, apiKey);
      console.log(`\n✅ ${rawAssets.length} models (old API — category/tags/triCount unavailable)`);
      assets = await fetchAndExtractClips(rawAssets, cachedClips, cachedStyleTags);
    } catch (oldErr) {
      throw new Error(
        `Both APIs failed. Old API: ${oldErr instanceof Error ? oldErr.message : oldErr}`,
      );
    }
  }

  writeFileSync(outFile, JSON.stringify({ platform: "poly.pizza", assets }, null, 2));

  const animatedCount = assets.filter((a) => a.animated).length;
  const withClips = assets.filter((a) => a.animationClips.length > 0).length;
  console.log(`\n📝 ${outFile}`);
  console.log(`✅ ${assets.length} assets | ${animatedCount} animated | ${withClips} with clips`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.POLY_PIZZA_API_KEY;
  if (!apiKey) {
    console.error("❌ POLY_PIZZA_API_KEY not set");
    process.exit(1);
  }

  const usernameArg = process.argv[2];

  if (usernameArg) {
    // Fetch a single specified creator
    await fetchCreator(usernameArg, apiKey);
  } else {
    // Fetch all poly.pizza creators from config that don't yet have a source file
    const config = loadConfig();
    const creators = polyPizzaCreators(config);

    if (creators.length === 0) {
      console.log("No poly.pizza creators listed in sources.config.json");
      return;
    }

    const missing = creators.filter(
      (c) => !existsSync(join(SOURCES_DIR, `${c.toLowerCase().replace(/\s+/g, "-")}.json`)),
    );

    if (missing.length === 0) {
      console.log(
        `✅ All ${creators.length} creators already fetched. Use a username arg to refresh one.`,
      );
      return;
    }

    console.log(`📋 ${missing.length} creator(s) to fetch: ${missing.join(", ")}\n`);
    const failed: string[] = [];
    for (const creator of missing) {
      console.log(`\n${"─".repeat(50)}`);
      try {
        await fetchCreator(creator, apiKey);
      } catch (err) {
        console.error(
          `⚠️  Skipping ${creator}: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed.push(creator);
      }
    }
    if (failed.length > 0) {
      console.error(`\n❌ Failed creators: ${failed.join(", ")}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
