# 3d-assets-search MCP Server

Searches 1,400+ free low-poly 3D assets (Quaternius) by name, category, or animation clip.
Returns direct GLB download URLs usable immediately in Three.js / React Three Fiber.

## Tools

| Tool                   | Description                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `search_assets`        | Full-text search with synonym expansion. Returns ranked GLB URLs.                                                         |
| `list_animation_clips` | Lists all unique clip names, optionally filtered by category. Call before `search_assets` to discover what motions exist. |
| `list_categories`      | Lists every asset category with counts.                                                                                   |
| `get_asset`            | Fetches full details for one asset by ID.                                                                                 |

### Synonym expansion

`search_assets` understands semantic intent:

| Query    | Also matches                          |
| -------- | ------------------------------------- |
| `run`    | Gallop, Running, Sprint               |
| `attack` | Bite, Punch, Slash, Stab, Sword, Kick |
| `die`    | Death, Dead                           |
| `hit`    | HitReact, HitReceive                  |
| `human`  | Character, Person, Man, Woman         |
| `quad`   | Horse, Wolf, Cow, Deer, Dog, Cat      |

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Generate the search index

Run once (or after updating the raw asset data):

```bash
bun run preprocess
```

This reads `data/quaternius-index.json` and writes the preprocessed search index to
`data/asset-search-preprocessed.json`.

### 3. Register in Claude Code / Claude Desktop

Add to your project's `.mcp.json`:

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

No environment variables required.

### 4. Start the server manually (optional)

```bash
bun run start
```

## Cloudflare Workers deployment (remote MCP)

The `cloudflare/` directory contains a second entry point targeting Cloudflare Workers.
It reuses the same pure search logic (`src/searcher.ts`, `src/tokenizer.ts`) and bundles
the preprocessed index at build time — no file I/O at runtime.

### Dev (local Worker)

```bash
bun install
bun run dev        # wrangler dev → http://localhost:8787/mcp
```

Test with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

### Deploy

```bash
bun run deploy     # wrangler deploy → https://3d-assets-search.zjudn2013.workers.dev/mcp
```

### Connect Claude Desktop / Code to the remote Worker

Via `mcp-remote` proxy (for clients that don't support HTTP MCP natively):

```json
{
  "mcpServers": {
    "3d-assets-search-remote": {
      "command": "npx",
      "args": ["mcp-remote", "https://3d-assets-search.zjudn2013.workers.dev/mcp"]
    }
  }
}
```

Cursor / Windsurf support direct HTTP MCP connections — just enter the `/mcp` URL.

## Development

```bash
bun run test      # run all tests (47 tests across 3 suites)
bun run lint      # oxlint
bun run format    # oxfmt --write
bun run check     # format + lint together
```

## Project structure

```
3d-assets-search/
├── __tests__/
│   ├── fixtures/
│   │   └── mock-index.ts          # shared RuntimeIndex fixture
│   ├── tokenizer.test.ts          # pure tokenization unit tests
│   ├── searcher.test.ts           # search logic unit tests
│   └── mcp-server.test.ts         # MCP protocol integration (InMemoryTransport)
├── cloudflare/
│   └── src/
│       └── index.ts               # Cloudflare Workers entry point (McpAgent)
├── data/
│   ├── quaternius-index.json          # raw source (gitignored)
│   └── asset-search-preprocessed.json # built index (committed, bundled by wrangler)
├── src/
│   ├── mcp-server.ts   # stdio MCP server — local Claude Code / Desktop
│   ├── searcher.ts     # search, listClips, getAssetById (shared by both transports)
│   ├── tokenizer.ts    # tokenize, expandTokens, synonym map (shared)
│   └── types.ts        # Zod schemas + TypeScript types (shared)
├── preprocess.ts       # one-time build script — generates the search index
├── wrangler.jsonc      # Cloudflare Workers config (Durable Objects)
├── vitest.config.ts
├── lefthook.yml        # pre-commit: oxfmt + oxlint
├── package.json
└── tsconfig.json
```

## Architecture

The search pipeline:

```
Query → tokenize → expandTokens → invertedIndex lookup → score → filter → paginate
```

- **Inverted index** is precomputed at build time for O(1) candidate lookup per token
- **`assetById` Map** is built once at server startup for O(1) `get_asset` lookups
- **Synonym expansion is one-directional**: `run → gallop` but `gallop` does not match all quad animals
- **`preprocess.ts`** is a build script, not server code — runs once to generate the index file
