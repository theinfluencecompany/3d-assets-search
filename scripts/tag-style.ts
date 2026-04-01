/**
 * Vision-based style tagging for 3D assets using Gemini Flash.
 * Analyzes asset thumbnails and writes descriptive style tags to source JSONs.
 * Already-tagged assets are skipped (cached).
 *
 * Usage:
 *   bun scripts/tag-style.ts                     # tag all untagged assets
 *   bun scripts/tag-style.ts Quaternius           # only process one creator
 *   bun scripts/tag-style.ts --force Quaternius   # re-tag even already-tagged assets
 *
 * Env: GEMINI_API_KEY (required)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_DIR = join(ROOT, "data", "sources");
const SOURCES_CONFIG_FILE = join(ROOT, "data", "sources.config.json");
const CONCURRENCY = 10;
const GEMINI_MODEL = "gemini-2.0-flash";

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

interface SourceAsset {
  id: string;
  title: string;
  thumbnail: string;
  styleTags: string[];
  [key: string]: unknown;
}

interface SourceFile {
  platform: string;
  assets: SourceAsset[];
}

// ─── Gemini Vision ─────────────────────────────────────────────────────────────

const STYLE_PROMPT = `Look at this 3D game asset render.
Return 3-5 descriptive tags that best capture its visual style, art direction, and overall aesthetic.
Include style terms (e.g. chibi, low-poly, cartoon, realistic, voxel) AND visual characteristics (e.g. rounded, blocky, colorful, dark, cute, rugged, sleek).
Reply with only the tags, comma-separated, lowercase.`;

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
    // Retry on rate-limit and transient server errors
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

async function getStyleTags(thumbnailUrl: string, apiKey: string): Promise<string[]> {
  const imgRes = await fetchWithRetry(thumbnailUrl, {});
  if (!imgRes.ok) return [];

  const rawType = imgRes.headers.get("content-type") ?? "";
  const contentType = rawType.startsWith("image/") ? rawType : "image/webp";
  const base64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: contentType, data: base64 } },
              { text: STYLE_PROMPT },
            ],
          },
        ],
        generationConfig: { temperature: 0.2, maxOutputTokens: 64 },
      }),
    },
  );

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(`Gemini ${res.status}: ${JSON.stringify(body)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return text
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.split(" ").length <= 2);
}

// ─── Process one creator ────────────────────────────────────────────────────────

async function tagCreator(creatorFile: string, force: boolean, apiKey: string): Promise<void> {
  const filePath = join(SOURCES_DIR, creatorFile);
  if (!existsSync(filePath)) {
    console.log(`⚠️  ${creatorFile} not found — skipping`);
    return;
  }

  const data = JSON.parse(readFileSync(filePath, "utf8")) as SourceFile;
  const toTag = force
    ? data.assets
    : data.assets.filter((a) => !a.styleTags || a.styleTags.length === 0);

  if (toTag.length === 0) {
    console.log(`✅ ${creatorFile}: all ${data.assets.length} assets already tagged`);
    return;
  }

  console.log(`\n🏷️  ${creatorFile}: tagging ${toTag.length}/${data.assets.length} assets...`);

  const tagMap = new Map<string, string[]>(data.assets.map((a) => [a.id, a.styleTags ?? []]));

  let done = 0;
  let failed = 0;

  for (let i = 0; i < toTag.length; i += CONCURRENCY) {
    const batch = toTag.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (asset) => {
        try {
          const tags = await getStyleTags(asset.thumbnail, apiKey);
          tagMap.set(asset.id, tags);
        } catch {
          failed++;
        }
        done++;
        process.stdout.write(`  [${done}/${toTag.length}] ${asset.title}   \r`);
      }),
    );
  }

  // Write back
  const updated: SourceFile = {
    ...data,
    assets: data.assets.map((a) => ({ ...a, styleTags: tagMap.get(a.id) ?? a.styleTags ?? [] })),
  };
  writeFileSync(filePath, JSON.stringify(updated, null, 2));

  const tagged = updated.assets.filter((a) => a.styleTags.length > 0).length;
  console.log(
    `\n✅ ${creatorFile}: ${tagged}/${data.assets.length} total tagged${failed > 0 ? ` (${failed} failed)` : ""}`,
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY not set");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const creatorArg = args.find((a) => a !== "--force");

  const config = loadConfig();

  let creators: string[];
  if (creatorArg) {
    creators = [creatorArg];
  } else {
    creators = allCreators(config);
    if (creators.length === 0) {
      console.log("No creators in sources.config.json");
      return;
    }
  }

  for (const creator of creators) {
    await tagCreator(`${creator.toLowerCase().replace(/\s+/g, "-")}.json`, force, apiKey);
  }

  console.log("\n🎉 Done. Run `bun run preprocess` to rebuild the index.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
