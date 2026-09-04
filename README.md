# bing-mcp — Bing Webmaster Tools MCP server

MCP server (stdio) that gives Claude Code direct access to this site's Bing
Webmaster Tools data plus IndexNow submission (PRD 0044). Research/ops
tooling like `gsc-mcp`: own dependencies, never part of the Astro build.

## Tools

| Tool                 | What it answers / does                                                                 |
| -------------------- | -------------------------------------------------------------------------------------- |
| `list_sites`         | Which sites can this API key see, and are they verified?                               |
| `query_stats`        | Top Bing search queries: impressions / clicks / position                               |
| `page_stats`         | Top pages by Bing search traffic                                                       |
| `rank_traffic_stats` | Daily Bing impressions / clicks trend                                                  |
| `list_sitemaps`      | Submitted sitemaps with status and URL counts                                          |
| `submit_sitemap`     | (Re)submit a sitemap URL                                                               |
| `remove_sitemap`     | Remove a submitted sitemap (the file itself is untouched)                              |
| `url_info`           | What Bing knows about one URL: discovery, last crawl, HTTP status                      |
| `submit_urls`        | Push up to 500 URLs into Bing's crawl queue; response includes the remaining quota     |
| `indexnow`           | Instant, quota-free "URL added/updated" ping to the IndexNow network (Bing, Yandex, …) |
| `crawl_stats`        | Bingbot activity: pages crawled, HTTP code buckets, robots blocks                      |
| `crawl_issues`       | Concrete URLs with crawl problems and their HTTP codes                                 |
| `keyword_research`   | Bing search volumes for a term (es/ES defaults); `related: true` → related keywords    |
| `backlinks`          | Inbound-link counts per page; with `url`, the linking pages + anchor texts             |

Every site-scoped tool takes an optional `siteUrl`; omitted, it uses the
`BING_SITE_URL` env var (set in [.mcp.json](../../.mcp.json) to
`https://eligefranquicia.es/` — the **apex**, because that is how the
property is registered in Bing: domain-scoped and DNS-verified, covering the
`www` subdomain the site actually serves. The same-origin checks are
subdomain-aware for the same reason).

## One-time setup (API key)

1. Sign in to [Bing Webmaster Tools](https://www.bing.com/webmasters) with
   the account that owns the verified site.
2. Open **Settings → API Access**, accept the terms and click **Generate
   API Key**. One key per user; it covers all the user's verified sites.
3. Save the key as `.secrets/bing-api-key.txt` at the repo root —
   `.secrets/` is git-ignored; never commit the key. (Alternatively set the
   `BING_API_KEY` env var, which overrides the file.)

Without the key the server still starts and registers its tools; every call
answers with these setup steps instead of data.

### IndexNow key (already provisioned, public by design)

The IndexNow protocol verifies ownership by fetching
`https://www.eligefranquicia.es/<key>.txt`, so the key file lives
**committed** in `public/` — it is not a secret; hosting it _is_ the proof.
`INDEXNOW_KEY_FILE` in `.mcp.json` points at it. The `indexnow` tool only
works once the site (with that file) is deployed; until then it returns the
403 explanation.

## Environment

- `BING_API_KEY_FILE` — path to the API-key file (relative paths resolve
  from the process working directory, i.e. the repo root when launched via
  `.mcp.json`). `BING_API_KEY` overrides it.
- `BING_SITE_URL` — default site for every tool (the apex property).
- `INDEXNOW_SITE_URL` — the deployed canonical host that serves the IndexNow
  key file (`https://www.eligefranquicia.es/`); governs the `indexnow`
  tool's origin check and key location. Falls back to `BING_SITE_URL`.
- `INDEXNOW_KEY_FILE` — path to the committed IndexNow key file
  (`public/<key>.txt`).

## Development

```sh
npm test                # node --test — offline, network mocked
npm run test:bing       # same, from the repo root
node server.mjs         # run manually (stdio; speaks MCP JSON-RPC)
```

`server.mjs` wires the MCP tools, `lib.mjs` holds the pure
validation/shaping helpers (fully unit-tested), and `bing.mjs` is the only
file that talks to the network (plain `fetch` against
`https://ssl.bing.com/webmaster/api.svc/json/…` and
`https://api.indexnow.org/indexnow`). API responses arrive wrapped in
`{"d": …}` with WCF `/Date(ms)/` timestamps; both are normalized before the
tool returns.
# bing-webmaster-mcp
