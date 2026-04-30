import type { Bounds, TaggedAssetsManifest, ThreeDFacing } from "../../src/types.js";
import { stableHash } from "../lib/hash.js";
import {
  listSourceFiles,
  loadBoundsManifest,
  loadTaggedManifest,
  parseCliArgs,
  readSourceFile,
  saveTaggedManifest,
} from "../lib/runtime.js";

const CONCURRENCY = 10;
const GEMINI_MODEL = "gemini-2.0-flash";
const PROMPT_VERSION = "v1";

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

const VALID_FACINGS = new Set<string>(["+x", "-x", "+z", "-z"]);

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

async function getAssetVisionData(
  thumbnailUrl: string,
  apiKey: string,
  bounds?: Bounds,
): Promise<{ styleTags: string[]; facing: ThreeDFacing | undefined }> {
  const imgRes = await fetchWithRetry(thumbnailUrl, {});
  if (!imgRes.ok) return { styleTags: [], facing: undefined };

  const rawType = imgRes.headers.get("content-type") ?? "";
  const contentType = rawType.startsWith("image/") ? rawType : "image/webp";
  const base64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

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
              { text: facingPrompt },
            ],
          },
        ],
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
  const fullText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const lines = fullText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const facingLine = [...lines].reverse().find((line) => VALID_FACINGS.has(line));
  const styleTags = lines
    .filter((line) => !VALID_FACINGS.has(line))
    .join(",")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag.split(" ").length <= 2);
  return { styleTags, facing: facingLine as ThreeDFacing | undefined };
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY not set");
    process.exit(1);
  }

  const { force, target } = parseCliArgs(process.argv.slice(2));
  const sourceFiles = listSourceFiles(target);
  const boundsManifest = loadBoundsManifest();
  const taggedManifest = loadTaggedManifest();
  const liveAssetIds = new Set<string>();

  for (const file of sourceFiles) {
    const source = readSourceFile(file);
    const models = source.assets.filter((asset) => asset.type === "model");
    console.log(`\n🏷️  ${file}`);
    let done = 0;

    for (let i = 0; i < models.length; i += CONCURRENCY) {
      const batch = models.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (asset) => {
          liveAssetIds.add(asset.id);
          const bounds = boundsManifest.assets[asset.id]?.bounds;
          const tagSignature = stableHash({
            thumbnail: asset.thumbnail,
            bounds: bounds ?? null,
            model: GEMINI_MODEL,
            promptVersion: PROMPT_VERSION,
          });
          const existing = taggedManifest.assets[asset.id];

          if (
            !force &&
            existing &&
            existing.tagSignature === tagSignature &&
            ["tagged", "skipped"].includes(existing.status)
          ) {
            done++;
            process.stdout.write(`  [${done}/${models.length}] — ${asset.id}\r`);
            return;
          }

          try {
            const result = await getAssetVisionData(asset.thumbnail, apiKey, bounds);
            taggedManifest.assets[asset.id] = {
              assetId: asset.id,
              sourceFile: file,
              tagSignature,
              status: "tagged",
              model: GEMINI_MODEL,
              promptVersion: PROMPT_VERSION,
              styleTags: result.styleTags,
              ...(result.facing ? { facing: result.facing } : {}),
              taggedAt: new Date().toISOString(),
              error: null,
            };
          } catch (err) {
            taggedManifest.assets[asset.id] = {
              assetId: asset.id,
              sourceFile: file,
              tagSignature,
              status: "failed",
              model: GEMINI_MODEL,
              promptVersion: PROMPT_VERSION,
              styleTags: [],
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

  for (const [assetId, entry] of Object.entries(taggedManifest.assets)) {
    if (sourceFiles.includes(entry.sourceFile) && !liveAssetIds.has(assetId)) {
      delete taggedManifest.assets[assetId];
    }
  }

  taggedManifest.updatedAt = new Date().toISOString();
  saveTaggedManifest(taggedManifest as TaggedAssetsManifest);
  console.log("\n✅ Tagged assets manifest updated");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
