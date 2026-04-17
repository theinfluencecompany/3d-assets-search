/**
 * Vision-based style tagging for 3D assets using Gemini Flash.
 * Analyzes asset thumbnails and writes descriptive style tags to source JSONs.
 * Already-tagged assets are skipped (cached).
 *
 * Also extracts facing direction (+x/-x/+z/-z) via a second prompt in the same API call.
 *
 * Usage:
 *   bun scripts/tag-style.ts                          # tag all untagged assets
 *   bun scripts/tag-style.ts Quaternius               # only process one creator
 *   bun scripts/tag-style.ts --force Quaternius       # re-tag style + facing
 *   bun scripts/tag-style.ts --force-facing           # re-tag facing only
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

type ThreeDFacing = "+x" | "-x" | "+z" | "-z";
const VALID_FACINGS = new Set<string>(["+x", "-x", "+z", "-z"]);

interface SourceAsset {
  id: string;
  title: string;
  thumbnail: string;
  styleTags: string[];
  facing?: ThreeDFacing;
  bounds?: { x: number; y: number; z: number };
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

const FACING_PROMPT = `Look at this 3D game asset render. Determine which direction the front of this object faces relative to the camera.
+z = front faces toward camera (you see the front/face directly)
-z = front faces away from camera (you see the back)
+x = front faces to the right
-x = front faces to the left
Reply with exactly one token: +z, -z, +x, or -x. No other text.`;

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

interface AssetVisionResult {
  styleTags: string[];
  facing: ThreeDFacing | undefined;
}

async function getAssetVisionData(
  thumbnailUrl: string,
  apiKey: string,
  needStyle: boolean,
  needFacing: boolean,
  bounds?: { x: number; y: number; z: number },
): Promise<AssetVisionResult> {
  const imgRes = await fetchWithRetry(thumbnailUrl, {});
  if (!imgRes.ok) return { styleTags: [], facing: undefined };

  const rawType = imgRes.headers.get("content-type") ?? "";
  const contentType = rawType.startsWith("image/") ? rawType : "image/webp";
  const base64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

  // Build prompts — image is shared, append only the prompts we need.
  // Each prompt is a separate text part; Gemini responds to each in order.
  const parts: Array<{ inline_data?: { mime_type: string; data: string }; text?: string }> = [
    { inline_data: { mime_type: contentType, data: base64 } },
  ];
  if (needStyle) parts.push({ text: STYLE_PROMPT });
  if (needFacing) {
    let facingPrompt = FACING_PROMPT;
    if (bounds) {
      const axes = [
        ["X", bounds.x],
        ["Y", bounds.y],
        ["Z", bounds.z],
      ] as const;
      const longest = axes.reduce((a, b) => (b[1] > a[1] ? b : a));
      facingPrompt = `This model's bounding box extents: X=${bounds.x}, Y=${bounds.y}, Z=${bounds.z} (longest axis: ${longest[0]}).\n${FACING_PROMPT}`;
    }
    parts.push({ text: facingPrompt });
  }

  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 128 },
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

  // Gemini returns a single merged text response (not one part per prompt).
  // Split on newlines to separate style tags line from facing line.
  const fullText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const lines = fullText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let styleTags: string[] = [];
  let facing: ThreeDFacing | undefined;

  if (needStyle && needFacing) {
    // First non-empty line(s) are style tags (comma-separated), last token line is facing.
    const facingLine = [...lines].reverse().find((l: string) => VALID_FACINGS.has(l));
    const styleLines = lines.filter((l) => !VALID_FACINGS.has(l));
    styleTags = styleLines
      .join(",")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && t.split(" ").length <= 2);
    facing = facingLine as ThreeDFacing | undefined;
  } else if (needStyle) {
    styleTags = fullText
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && t.split(" ").length <= 2);
  } else if (needFacing) {
    const token = lines.find((l) => VALID_FACINGS.has(l));
    facing = token as ThreeDFacing | undefined;
  }

  return { styleTags, facing };
}

// ─── Process one creator ────────────────────────────────────────────────────────

async function tagCreator(
  creatorFile: string,
  forceStyle: boolean,
  forceFacing: boolean,
  apiKey: string,
): Promise<void> {
  const filePath = join(SOURCES_DIR, creatorFile);
  if (!existsSync(filePath)) {
    console.log(`⚠️  ${creatorFile} not found — skipping`);
    return;
  }

  const data = JSON.parse(readFileSync(filePath, "utf8")) as SourceFile;

  // Skip HDRIs — they don't need vision-based style tagging
  const models = data.assets.filter((a) => (a as { type?: string }).type !== "hdri");

  // Determine which assets need each kind of annotation
  const needsStyle = (a: SourceAsset) => forceStyle || !a.styleTags || a.styleTags.length === 0;
  const needsFacing = (a: SourceAsset) => forceFacing || !a.facing;
  const toProcess = models.filter((a) => needsStyle(a) || needsFacing(a));

  if (toProcess.length === 0) {
    console.log(`✅ ${creatorFile}: all ${data.assets.length} assets already tagged`);
    return;
  }

  console.log(
    `\n🏷️  ${creatorFile}: processing ${toProcess.length}/${data.assets.length} assets...`,
  );

  const styleMap = new Map<string, string[]>(data.assets.map((a) => [a.id, a.styleTags ?? []]));
  const facingMap = new Map<string, ThreeDFacing | undefined>(
    data.assets.map((a) => [a.id, a.facing]),
  );

  let done = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (asset) => {
        try {
          const result = await getAssetVisionData(
            asset.thumbnail,
            apiKey,
            needsStyle(asset),
            needsFacing(asset),
            asset.bounds,
          );
          if (result.styleTags.length > 0) styleMap.set(asset.id, result.styleTags);
          if (result.facing) facingMap.set(asset.id, result.facing);
        } catch {
          failed++;
        }
        done++;
        process.stdout.write(`  [${done}/${toProcess.length}] ${asset.title}   \r`);
      }),
    );
  }

  // Write back
  const updated: SourceFile = {
    ...data,
    assets: data.assets.map((a) => {
      const facing = facingMap.get(a.id);
      return {
        ...a,
        styleTags: styleMap.get(a.id) ?? a.styleTags ?? [],
        ...(facing ? { facing } : {}),
      };
    }),
  };
  writeFileSync(filePath, JSON.stringify(updated, null, 2));

  const withStyle = updated.assets.filter((a) => a.styleTags.length > 0).length;
  const withFacing = updated.assets.filter((a) => a.facing).length;
  console.log(
    `\n✅ ${creatorFile}: ${withStyle}/${data.assets.length} styled, ${withFacing}/${data.assets.length} with facing${failed > 0 ? ` (${failed} failed)` : ""}`,
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
  const forceStyle = args.includes("--force");
  const forceFacing = args.includes("--force-facing") || forceStyle;
  const creatorArg = args.find((a) => !a.startsWith("--"));

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
    await tagCreator(
      `${creator.toLowerCase().replace(/\s+/g, "-")}.json`,
      forceStyle,
      forceFacing,
      apiKey,
    );
  }

  console.log("\n🎉 Done. Run `bun run preprocess` to rebuild the index.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
