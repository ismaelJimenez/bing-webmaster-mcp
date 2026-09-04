# bing-webmaster-mcp

MCP server (stdio) for [Bing Webmaster Tools](https://www.bing.com/webmasters):
search performance, sitemaps, URL submission, IndexNow, crawl diagnostics,
keyword volumes and inbound links, for Claude Code, Claude Desktop, Cursor and
any other MCP client.

Plain Node.js, two dependencies, no build step. The only network calls go to
`ssl.bing.com` and `api.indexnow.org`.

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
| `keyword_research`   | Bing search volumes for a term in a market; `related: true` → related keywords         |
| `backlinks`          | Inbound-link counts per page; with `url`, the linking pages + anchor texts             |

Every site-scoped tool takes an optional `siteUrl`. When omitted it uses the
`BING_SITE_URL` environment variable. Pass the site exactly as it is
registered in Bing Webmaster Tools. For a domain-scoped property that is the
apex (`https://example.com/`), and URLs on its subdomains are accepted by the
submission tools.

Responses are JSON. Bing's `{"d": …}` wrapper and WCF `/Date(ms)/` timestamps
are normalized before the tool returns.

## Setup

### 1. Get an API key

1. Sign in to [Bing Webmaster Tools](https://www.bing.com/webmasters) with the
   account that owns the verified site.
2. Open **Settings → API Access**, accept the terms and click **Generate API
   Key**. One key per user; it covers all the user's verified sites.

Without a key the server still starts and registers its tools; every call
answers with these setup steps instead of data.

### 2. Add the server to your client

Claude Code (`.mcp.json` in the project, or `claude mcp add`):

```json
{
  "mcpServers": {
    "bing-webmaster": {
      "command": "npx",
      "args": ["-y", "bing-webmaster-mcp"],
      "env": {
        "BING_API_KEY": "your-api-key",
        "BING_SITE_URL": "https://example.com/"
      }
    }
  }
}
```

Claude Desktop (`claude_desktop_config.json`) and Cursor (`.cursor/mcp.json`)
take the same block.

If the config file is committed to version control, keep the key out of it:
save the key in a file outside the repo and set `BING_API_KEY_FILE` to its
path instead of `BING_API_KEY`.

### 3. IndexNow (optional)

The [IndexNow](https://www.indexnow.org/) protocol verifies ownership by
fetching `https://<your-host>/<key>.txt`, so the key is public by design.

1. Generate a key: 8–128 characters of `a-z`, `A-Z`, `0-9` and `-`.
2. Host it as `<key>.txt` at the root of the site (it must return the key as
   plain text).
3. Keep a local copy of that file and set `INDEXNOW_KEY_FILE` to its path.
   The file name must match its content.

If the key file is not yet reachable, the `indexnow` tool returns the 403
explanation instead of a bare error.

## Environment

| Variable            | Meaning                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BING_API_KEY`      | The API key. Overrides `BING_API_KEY_FILE`.                                                                                      |
| `BING_API_KEY_FILE` | Path to a file containing the API key. Relative paths resolve from the process working directory.                                |
| `BING_SITE_URL`     | Default site for every site-scoped tool, as registered in Bing Webmaster Tools.                                                  |
| `INDEXNOW_KEY_FILE` | Path to your local copy of the IndexNow key file (`<key>.txt`).                                                                  |
| `INDEXNOW_SITE_URL` | The host that serves the key file, when it differs from `BING_SITE_URL` (e.g. property on the apex, site served on `www`). Governs the `indexnow` tool's origin check and key location. |

## Development

```sh
npm install
npm test            # node --test — offline, network mocked
node server.mjs     # run manually (stdio; speaks MCP JSON-RPC)
```

`server.mjs` wires the MCP tools, `lib.mjs` holds the pure validation and
shaping helpers (unit-tested), and `bing.mjs` is the only file that talks to
the network.

## License

MIT
