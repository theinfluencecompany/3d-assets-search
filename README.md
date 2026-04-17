# 3d-assets-search MCP Server

Searches 6400+ free 3D assets and HDRIs from multiple sources (Quaternius, Kenney, Poly Haven, and more) by name, category, style, or animation clip.
Returns direct download URLs (GLB/GLTF for models, EXR for HDRIs) usable immediately in Three.js / React Three Fiber.

## Architecture

### Data pipeline

```
poly.pizza API                        GLB files (static.poly.pizza)
  v1.1: /v1.1/user/{creator}               /{uuid}.glb
    → paginated 32/page                        │
    → cycle detection (API loops on overflow)  │  Range: bytes=0-19   → JSON chunk length
    → user.lists[] → /v1.1/list/{id}           │  Range: bytes=20-N   → animations[].name
  fallback: poly.pizza/api/user/{creator}       │
    → if v1.1 returns 500 (server bug)         │
    → category/tags/triCount unavailable        │
    → GLB checked for ALL assets (animated unknown)
        │                                      │
        │   scripts/fetch-polypizza.ts          │
        └──────────────┬───────────────────────┘
                       │
                       │
Poly Haven API         │
  /assets?t=models     │   ~433 3D models (GLTF, CC0)
  /assets?t=hdris      │   ~959 HDRIs (EXR, CC0)
  /files/{id}          │   download URLs per resolution
        │              │
        │   scripts/fetch-polyhaven.ts
        └──────┬───────┘
               │
               ▼
      data/sources/{creator}.json
      { assets: [{ id, title, type, category, tags,
                   styleTags, animated, animationClips,
                   license, triCount,
                   thumbnail, download, sourceUrl,
                   bounds?, facing? }] }
               │
               │   scripts/extract-bounds.ts
               │   GLB Range requests → AABB min/max → bounds {x,y,z}
               │   (poly.pizza models only — Poly Haven has API bounds)
               │   (skips HDRIs and assets with existing bounds)
               │
               │   scripts/tag-style.ts
               │   Gemini Vision API → thumbnail + bounds context → styleTags + facing
               │   (models only — HDRIs skipped)
               │   cached: assets with styleTags/facing skipped
               │
               │   data/sources.config.json
               │   (platform → access mode)
               │
               │   scripts/preprocess.ts
               ▼
      BM25 index build (two passes):
        Pass 1 — weighted TF + docLength per asset
        Pass 2 — IDF per token, BM25 tokenWeights
      + invertedIndex  (token → [assetId])
      + titleTokens    (stemmed title, for phrase boost)
      + allClips       (all unique animation clip names)
               │
               ▼
      data/asset-search-preprocessed.json
               │
      loaded once at startup
               │
               ▼
      RuntimeIndex (in-memory)
      + assetById Map<id, ProcessedAsset>
```

### Query pipeline

```
Claude calls search_assets("running wolf")
        │
        │  src/searcher.ts
        ▼
tokenizeRaw → expandTokens (synonyms) → stem (Porter)
        │
        ▼
invertedIndex candidate lookup  O(1) per token
        │
        ▼
scoreAsset:
  Σ tokenWeights[token]          BM25 pre-baked score
  + ANIMATED_MOTION_BONUS        if query implies motion + asset is animated
  × PHRASE_BOOST (1.5×)          if all tokens appear in asset.titleTokens
        │
        ▼
filter by type (model/hdri), category, animatedOnly
        │
        ▼
sort → paginate → AssetResult[]
  { id, title, type, category, animated,
    animationClips, download, sourceUrl, score,
    bounds?, facing? }
```

### Zero-result fallback

If the scored total is 0 and the query has multiple tokens, the searcher retries
matching any single token and returns partial results with `fallback: true`.
Claude sees a tip: "No exact matches — showing partial results."

---

## Sources

| Source | Type | Assets | Access |
|--------|------|--------|--------|
| poly.pizza (Quaternius, Kenney, Zsky, J-Toastie, MilkAndBanana, Pichuliru, Poly by Google, Kay Lousberg) | 3D models (GLB) | ~5000 | Open CDN |
| Poly Haven — models | 3D models (GLTF) | ~433 | Open CDN |
| Poly Haven — HDRIs | Environment maps (EXR) | ~959 | Open CDN |

---

## Search quality

### BM25 scoring

Token weights are pre-baked at index build time using BM25 (k₁=1.5, b=0.75).
IDF automatically down-weights common tokens like "character" and boosts rare ones like "trebuchet".
Field weights (title=10, category=5, tags=4, styleTags=4, clips=3, creator=2) control per-field TF contribution.

### Porter stemming

Applied at both index time and query time — queries match stemmed forms automatically:

| Input      | Stem   |
| ---------- | ------ |
| `wolves`   | `wolv` |
| `running`  | `run`  |
| `animated` | `anim` |
| `nature`   | `natur`|
| `polygon`  | `polygon` |

### Synonym expansion

One-directional expansion — applied to raw query tokens before stemming:

| Query    | Also searches                       |
| -------- | ----------------------------------- |
| `run`    | gallop, running, sprint             |
| `attack` | bite, punch, slash, stab, kick      |
| `die`    | death, dead                         |
| `hit`    | hitreact, hitreceive                |
| `chibi`  | cute, blocky, cartoon               |
| `human`  | character, person, man, woman       |
| `quad`   | horse, wolf, cow, deer, dog, cat    |

### Vision style tagging

Each model's thumbnail is analyzed by Gemini Vision to generate 3–5 style tags (e.g. `chibi`, `low-poly`, `cartoon`, `realistic`, `ornate`).
The facing prompt also receives bounding box dimensions when available, helping Gemini determine orientation from geometry (e.g. a long thin model along X likely faces +z/-z).
These `styleTags` are stored in the source JSON and indexed at the same weight as creator tags (4).
This lets queries like "chibi character" or "realistic furniture" find assets that creators never explicitly tagged as such.

Tags are generated once and cached — re-runs only process new untagged assets. HDRIs are skipped (no visual style tagging needed).

### Phrase boost

When all query tokens appear in an asset's title, the score is multiplied by 1.5×.
"running wolf" ranks wolf assets with both words in the title above assets that only match one.

---

## Tools

| Tool                   | Description                                                                    |
| ---------------------- | ------------------------------------------------------------------------------ |
| `search_assets`        | BM25 full-text search with synonym expansion, stemming, and phrase boost. Supports `type` filter (`model`/`hdri`). |
| `list_animation_clips` | Lists all unique clip names, optionally filtered by category.                  |
| `list_categories`      | Lists every asset category with counts.                                        |
| `get_asset`            | Fetches full details for one asset by ID.                                      |

---

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment

```bash
cp .env.example .env.local
# Fill in POLY_PIZZA_API_KEY (required for poly.pizza fetch)
# GEMINI_API_KEY (required for vision tagging)
# R2 credentials optional — only needed for restricted-access sources
```

### 3. Fetch source data

```bash
bun run fetch                   # fetch all sources (poly.pizza + Poly Haven)
bun run fetch:polypizza         # fetch poly.pizza creators only
bun run fetch:polyhaven         # fetch Poly Haven models + HDRIs only
bun run fetch:polypizza Quaternius  # fetch/refresh one specific creator
```

Poly Haven fetch requires no API key (open access). poly.pizza fetch requires `POLY_PIZZA_API_KEY`.
Existing data is cached — re-runs skip already-fetched sources. Use `--force` to refresh.

### 4. Extract bounds + tag styles

```bash
bun run bounds                  # extract AABB from GLBs (poly.pizza models only, incremental)
bun run tag                     # Gemini vision tagging (models only, incremental)
bun run tag polyhaven           # tag one source only
```

### 5. Build the search index

```bash
bun run preprocess
```

Reads all `data/sources/*.json` → applies BM25 → writes `data/asset-search-preprocessed.json`.
Open-access sources keep their CDN URLs as-is. Restricted sources upload GLBs to R2.

### 6. Run locally

```bash
bun run start    # preprocess + stdio MCP server
```

Register in `.mcp.json`:

```json
{
  "mcpServers": {
    "3d-assets-search": {
      "command": "bun",
      "args": ["mcp-servers/3d-assets-search/src/mcp-server.ts"]
    }
  }
}
```

---

## Full pipeline

```bash
bun run pipeline    # fetch → bounds → tag → preprocess (all in sequence)
```

---

## Adding a new creator (poly.pizza)

1. Add the username to `data/sources.config.json`:

```json
{
  "platforms": {
    "poly.pizza": {
      "access": "open",
      "creators": ["Quaternius", "NewCreator"]
    }
  }
}
```

2. Run:

```bash
bun run pipeline     # fetch + bounds + tag + preprocess
bun run deploy       # optional
```

## Adding a restricted-access source

1. Manually create `data/sources/<creator>.json` with asset metadata and source download URLs,
   and set `"platform": "restricted"` at the top level:

```json
{
  "platform": "restricted",
  "assets": [{ "id": "...", "title": "...", "download": "https://source-url/file.glb", ... }]
}
```

2. Add R2 credentials to `.env.local`.
3. Run `bun run preprocess` — this uploads GLBs to R2 and rewrites download URLs.

No changes to `sources.config.json` needed — `restricted` is already a known platform.

---

## Project structure

```
3d-assets-search/
├── data/
│   ├── sources/                          # per-creator JSONs (gitignored, .gitkeep keeps folder)
│   │   └── {creator}.json
│   ├── sources.config.json               # platforms → access mode + creator list
│   └── asset-search-preprocessed.json   # built index (gitignored — derived artifact)
├── scripts/
│   ├── fetch-polypizza.ts                # poly.pizza API → sources/{creator}.json + GLB clips
│   ├── fetch-polyhaven.ts                # Poly Haven API → sources/polyhaven.json (models + HDRIs)
│   ├── extract-bounds.ts                 # GLB AABB extraction → bounds {x,y,z}
│   ├── tag-style.ts                      # Gemini Vision → styleTags + facing (with bounds context)
│   └── preprocess.ts                     # sources/*.json → BM25 index + optional R2 upload
├── src/
│   ├── mcp-server.ts                     # stdio entry (local Claude Code / Desktop)
│   ├── worker.ts                         # Cloudflare Workers entry (HTTP MCP + R2 serving)
│   ├── searcher.ts                       # BM25 search, phrase boost, fallback, listClips
│   ├── tokenizer.ts                      # tokenize, stem, expandTokens, synonym map
│   ├── tools.ts                          # MCP tool definitions (shared by both transports)
│   └── types.ts                          # Zod schemas + TypeScript types
├── tests/
│   ├── fixtures/mock-index.ts
│   ├── tokenizer.test.ts
│   ├── searcher.test.ts
│   └── mcp-server.test.ts
├── wrangler.jsonc
├── .env.example
└── package.json
```

## npm scripts

| Script                | What it does                                                                   |
| --------------------- | ------------------------------------------------------------------------------ |
| `bun run fetch`       | Fetch all sources (poly.pizza + Poly Haven)                                    |
| `bun run fetch:polypizza` | Fetch poly.pizza creators; `bun run fetch:polypizza <Name>` for one        |
| `bun run fetch:polyhaven` | Fetch Poly Haven models + HDRIs; `--force` to refresh                      |
| `bun run bounds`      | Extract AABB bounds from GLBs (incremental, skips HDRIs + existing bounds)     |
| `bun run tag`         | Generate vision-based style tags + facing via Gemini (models only, incremental) |
| `bun run preprocess`  | Build BM25 search index from `data/sources/*.json`                             |
| `bun run pipeline`    | `fetch` + `bounds` + `tag` + `preprocess` in sequence                          |
| `bun run start`       | Preprocess then start local stdio MCP server                                   |
| `bun run dev`         | Preprocess then `wrangler dev`                                                 |
| `bun run deploy`      | Preprocess then `wrangler deploy`                                              |
| `bun run test`        | Run unit + integration tests                                                   |

## Cloudflare Workers deployment

```bash
bun run dev        # wrangler dev → http://localhost:8787/mcp
bun run deploy     # deploys to production
```

Connect via `mcp-remote` (for clients without native HTTP MCP):

```json
{
  "mcpServers": {
    "3d-assets-search": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.fried.gg/mcp"]
    }
  }
}
```

Cursor / Windsurf: enter `https://mcp.fried.gg/mcp` directly as an HTTP MCP endpoint.
