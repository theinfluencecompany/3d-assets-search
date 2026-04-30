# 3d-assets-search MCP Server

Searches 6400+ free 3D assets and HDRIs from multiple sources (Quaternius, Kenney, Poly Haven, and more) by name, category, style, or animation clip.
Returns direct download URLs (GLB/GLTF for models, EXR for HDRIs) usable immediately in Three.js / React Three Fiber.

## Architecture

This repository is transitioning from a single-step `preprocess` pipeline to a staged asset pipeline. The sections below describe the target architecture that the codebase is moving toward, while the current implementation still contains some legacy responsibilities inside `scripts/preprocess/index.ts`.

### Update model

Two update models were considered:

1. Full scan + incremental execution
   - On each run, scan all current source assets
   - Recompute per-asset signatures
   - Compare against stage JSON state
   - Only execute expensive work for changed assets

2. Event-driven / database-style fine-grained updates
   - Treat each asset change as an explicit insert / update / delete event
   - Prepare / bounds / tag react only to affected assets
   - Requires a trusted change journal, mutation API, or database revision model

The current target architecture chooses the first model because the repository is still file-driven (`sources/*.json`) rather than event-driven. Full scans are cheap at the current scale; repeated downloads, conversions, uploads, and vision calls are the real cost centers.

### Data pipeline

```
data/sources.config.json
  producer: engineer
  consumers: scripts/fetch/*, scripts/prepare/*, scripts/bounds/*, scripts/tag/*
        │
        ▼
scripts/fetch/polyhaven.ts
scripts/fetch/polypizza.ts
  producers: data/sources/*.json
  output: source facts only
    - metadata
    - source download URL
    - downloadIncludes (when available)
    - thumbnail
    - sourceUrl
    - animated / clips
        │
        ▼
data/sources/*.json
  producer: fetch scripts
  consumers: prepare / bounds / tag / preprocess
        │
        ▼
scripts/prepare/*
  input: sources/*.json
  output:
    - data/manifests/prepared-assets.json
    - R2 objects ({id}.glb)
  rules:
    - models only
    - prefer ZIP
    - fallback to glTF + downloadIncludes
    - HDRIs stay on source URLs
        │
        ├──────────────► Cloudflare R2
        │                 producer: prepare
        │                 consumer: src/worker.ts (/files/{id}.glb)
        │
        ▼
data/manifests/prepared-assets.json
  producer: prepare
  consumer: bounds / tag / preprocess
  contains:
    - prepareSignature
    - status
    - preparedUrl
    - preparedKey
        │
        ▼
scripts/bounds/index.ts
  input: prepared-assets.json
  output: data/manifests/bounds.json
  rule: compute bounds from prepared, directly accessible model URLs
        │
        ▼
scripts/tag/index.ts
  input: sources/*.json + bounds.json
  output: data/manifests/tagged-assets.json
  rule: Gemini Vision tags thumbnail; facing may use bounds context
        │
        ▼
scripts/preprocess/index.ts
  inputs:
    - data/sources/*.json
    - data/manifests/prepared-assets.json
    - data/manifests/bounds.json
    - data/manifests/tagged-assets.json
  integration key: asset id
  output:
    - final merged asset view
    - BM25 index
    - invertedIndex
    - titleTokens
    - allClips
        │
        ▼
data/asset-search-preprocessed.json
        │
        ▼
src/mcp-server.ts / src/worker.ts
  consumers: local MCP clients / remote HTTP MCP clients
  search output:
    id, title, category, type, animated,
    animationClips, download, thumbnail, sourceUrl,
    score, bounds?, facing?
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
In the target architecture these `styleTags` and `facing` values live in `data/manifests/tagged-assets.json` and are merged during `preprocess`.
This lets queries like "chibi character" or "realistic furniture" find assets that creators never explicitly tagged as such.

Tags are generated incrementally. Each asset records a `tagSignature` derived from thumbnail, bounds, prompt version, and vision model; re-runs only process assets whose inputs changed. HDRIs are skipped.

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

### 4. Prepare accessible assets

```bash
bun run prepare                # normalize model formats + upload GLBs to R2
```

### 5. Extract bounds + tag styles

```bash
bun run bounds                 # compute AABB bounds from prepared, accessible models
bun run tag                    # Gemini vision tagging (models only, incremental)
bun run tag polyhaven          # tag one source only
```

### 6. Build the search index

```bash
bun run preprocess
```

Reads and integrates:

- `data/sources/*.json`
- `data/manifests/prepared-assets.json`
- `data/manifests/bounds.json`
- `data/manifests/tagged-assets.json`

Then applies BM25 and writes `data/asset-search-preprocessed.json`.

### 7. Run locally

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
bun run pipeline    # fetch → prepare → bounds → tag → preprocess
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
bun run pipeline     # fetch + prepare + bounds + tag + preprocess
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
3. Run `bun run prepare` to normalize models and upload GLBs to R2, then run `bun run preprocess`.

No changes to `sources.config.json` needed — `restricted` is already a known platform.

---

## Project structure

```
3d-assets-search/
├── data/
│   ├── manifests/
│   │   ├── prepared-assets.json          # prepare stage state + final prepared URLs
│   │   ├── bounds.json                   # computed bounds from prepared models
│   │   └── tagged-assets.json            # styleTags + facing from visual tagging
│   ├── sources/                          # per-source asset facts
│   │   └── {source}.json
│   ├── sources.config.json               # platforms → access mode + creator list
│   └── asset-search-preprocessed.json    # built index (derived artifact)
├── scripts/
│   ├── fetch/
│   │   ├── polyhaven.ts                  # Poly Haven API → sources/polyhaven.json
│   │   └── polypizza.ts                  # poly.pizza API → sources/{creator}.json
│   ├── prepare/                          # source download → prepared URL / R2 object
│   ├── bounds.ts                         # prepared model URL → bounds.json
│   ├── tag.ts                            # thumbnail + bounds → tagged-assets.json
│   ├── preprocess.ts                     # merge manifests + build BM25 index
│   └── lib/
│       ├── diff.ts
│       ├── gltf-to-glb.ts
│       ├── hash.ts
│       └── polyhaven-resolver.ts
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
| `bun run prepare`     | Normalize model formats and upload prepared GLBs to R2                         |
| `bun run bounds`      | Extract AABB bounds from prepared, accessible model URLs                    |
| `bun run tag`         | Generate vision-based style tags + facing via Gemini (models only, incremental) |
| `bun run preprocess`  | Merge source + manifest state and build BM25 search index                      |
| `bun run pipeline`    | `fetch` + `prepare` + `bounds` + `tag` + `preprocess`                          |
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
