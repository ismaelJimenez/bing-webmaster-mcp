#!/usr/bin/env node
// MCP server (stdio) for Bing Webmaster Tools.
// Tools: list_sites, query_stats, page_stats, rank_traffic_stats,
// list_sitemaps, submit_sitemap, remove_sitemap, url_info, submit_urls,
// indexnow, crawl_stats, crawl_issues, keyword_research, backlinks.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { bingErrorMessage, createBingClient, createIndexNow } from './bing.mjs';
import {
  BingInputError,
  BingSetupError,
  MAX_BATCH_URLS,
  assertIsoDate,
  assertSameOrigin,
  resolveSiteUrl,
  validateUrlBatch,
} from './lib.mjs';

const siteUrlInput = z
  .string()
  .optional()
  .describe(
    'Site as registered in Bing Webmaster Tools (e.g. https://www.example.com/). ' +
      'Defaults to the BING_SITE_URL environment variable.',
  );

const requireHttpUrl = (url, field = 'url') => {
  if (!/^https?:\/\//.test(url ?? '')) {
    throw new BingInputError(
      `\`${field}\` must be a fully-qualified http(s) URL, got: ${JSON.stringify(url)}`,
    );
  }
};

const isoDay = (date) => date.toISOString().slice(0, 10);

export function createServer({
  env = process.env,
  clientFactory = createBingClient,
  indexNowFactory = createIndexNow,
} = {}) {
  const server = new McpServer({ name: 'bing', version: '0.1.0' });

  // Auth is lazy and cached only on success, so a checkout without a key
  // still starts the server and every call gets the setup instructions.
  let client;
  const getClient = async () =>
    (client ??= await clientFactory({ keyFile: env.BING_API_KEY_FILE, env }));

  // IndexNow needs the host that actually serves the key file (the deployed
  // canonical site), which may differ from the Bing property registration
  // (e.g. apex-domain property, www site).
  const indexNowSite = () =>
    env.INDEXNOW_SITE_URL ?? resolveSiteUrl(undefined, env);

  let indexNow;
  const getIndexNow = async () =>
    (indexNow ??= await indexNowFactory({
      keyFile: env.INDEXNOW_KEY_FILE,
      siteUrl: indexNowSite(),
      env,
    }));

  const run = (handler) => async (args) => {
    try {
      const text = await handler(args ?? {});
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const text =
        err instanceof BingSetupError || err instanceof BingInputError
          ? err.message
          : bingErrorMessage(err);
      return { content: [{ type: 'text', text }], isError: true };
    }
  };

  /** Most Bing reads share the shape (siteUrl) → rows; register them in one go. */
  const registerSiteReport = (name, description, method) => {
    server.registerTool(
      name,
      { description, inputSchema: { siteUrl: siteUrlInput } },
      run(async ({ siteUrl }) => {
        const site = resolveSiteUrl(siteUrl, env);
        const rows = await (await getClient())[method](site);
        return JSON.stringify(
          { siteUrl: site, rowCount: rows?.length ?? 0, rows },
          null,
          2,
        );
      }),
    );
  };

  server.registerTool(
    'list_sites',
    {
      description:
        'List the sites this Bing Webmaster Tools API key can access, with verification status.',
      inputSchema: {},
    },
    run(async () => {
      const sites = await (await getClient()).getUserSites();
      return JSON.stringify(sites, null, 2);
    }),
  );

  registerSiteReport(
    'query_stats',
    'Top search queries on Bing for the site: impressions, clicks and average position ' +
      'over the trailing period the API serves (~6 months).',
    'getQueryStats',
  );

  registerSiteReport(
    'page_stats',
    'Top pages by Bing search traffic for the site (impressions and clicks per page).',
    'getPageStats',
  );

  registerSiteReport(
    'rank_traffic_stats',
    'Daily Bing impressions and clicks trend for the whole site.',
    'getRankAndTrafficStats',
  );

  registerSiteReport(
    'crawl_stats',
    'Bingbot crawl activity over time: pages crawled, in-index counts, HTTP code buckets ' +
      '(2xx/301/302/4xx/5xx), robots.txt blocks and crawl errors.',
    'getCrawlStats',
  );

  registerSiteReport(
    'crawl_issues',
    'Concrete URLs with crawl issues Bing found on the site (HTTP errors, robots blocks, ' +
      'malware flags), with their HTTP code.',
    'getCrawlIssues',
  );

  registerSiteReport(
    'list_sitemaps',
    'Sitemaps Bing knows for the site, with processing status, URL counts and last-crawl time.',
    'getFeeds',
  );

  server.registerTool(
    'submit_sitemap',
    {
      description: 'Submit (or resubmit) a sitemap URL for the site.',
      inputSchema: {
        siteUrl: siteUrlInput,
        feedUrl: z
          .string()
          .describe(
            'Full sitemap URL, e.g. https://www.example.com/sitemap-index.xml',
          ),
      },
    },
    run(async ({ siteUrl, feedUrl }) => {
      requireHttpUrl(feedUrl, 'feedUrl');
      const site = resolveSiteUrl(siteUrl, env);
      await (await getClient()).submitFeed(site, feedUrl);
      return `Sitemap submitted to Bing for ${site}: ${feedUrl}`;
    }),
  );

  server.registerTool(
    'remove_sitemap',
    {
      description:
        'Remove a submitted sitemap from the site in Bing Webmaster Tools (does not delete the file).',
      inputSchema: {
        siteUrl: siteUrlInput,
        feedUrl: z
          .string()
          .describe('Full URL of the submitted sitemap to remove'),
      },
    },
    run(async ({ siteUrl, feedUrl }) => {
      requireHttpUrl(feedUrl, 'feedUrl');
      const site = resolveSiteUrl(siteUrl, env);
      await (await getClient()).removeFeed(site, feedUrl);
      return `Sitemap removed from Bing for ${site}: ${feedUrl}`;
    }),
  );

  server.registerTool(
    'url_info',
    {
      description:
        'What Bing knows about one URL of the site: discovery date, last crawl date, ' +
        'HTTP status and document details.',
      inputSchema: {
        siteUrl: siteUrlInput,
        url: z
          .string()
          .describe('Fully-qualified URL to look up; must belong to the site'),
      },
    },
    run(async ({ siteUrl, url }) => {
      requireHttpUrl(url);
      const site = resolveSiteUrl(siteUrl, env);
      const info = await (await getClient()).getUrlInfo(site, url);
      return JSON.stringify(info, null, 2);
    }),
  );

  server.registerTool(
    'submit_urls',
    {
      description:
        `Push up to ${MAX_BATCH_URLS} URLs of the site into Bing's crawl queue ` +
        '(SubmitUrlBatch). The response includes the remaining daily/monthly ' +
        'submission quota. URLs must belong to the site.',
      inputSchema: {
        siteUrl: siteUrlInput,
        urls: z
          .array(z.string())
          .describe(`Fully-qualified URLs to submit (1–${MAX_BATCH_URLS})`),
      },
    },
    run(async ({ siteUrl, urls }) => {
      const site = resolveSiteUrl(siteUrl, env);
      validateUrlBatch(urls);
      assertSameOrigin(urls, site);
      const bing = await getClient();
      await bing.submitUrlBatch(site, urls);
      const remainingQuota = await bing.getUrlSubmissionQuota(site);
      return JSON.stringify(
        { siteUrl: site, submitted: urls.length, remainingQuota },
        null,
        2,
      );
    }),
  );

  server.registerTool(
    'indexnow',
    {
      description:
        'Ping the IndexNow network (Bing, Yandex, Seznam, Naver…) that URLs of the site ' +
        'were added or updated — instant and quota-free. Requires the key file ' +
        '<key>.txt to be hosted at the site root.',
      inputSchema: {
        urls: z
          .array(z.string())
          .describe('Fully-qualified URLs of the site that were added/updated'),
      },
    },
    run(async ({ urls }) => {
      validateUrlBatch(urls);
      assertSameOrigin(urls, indexNowSite());
      const { status } = await (await getIndexNow()).submit(urls);
      return JSON.stringify({ status, submitted: urls.length }, null, 2);
    }),
  );

  server.registerTool(
    'keyword_research',
    {
      description:
        'Bing search-impression volume for a keyword over a date range — real numbers, ' +
        'no credentials beyond the API key. With `related: true`, returns related ' +
        'keywords and their volumes instead. Default range: trailing 3 months.',
      inputSchema: {
        q: z.string().describe('The keyword to look up, e.g. "coffee machine"'),
        country: z
          .string()
          .describe('Two-letter country code of the market, e.g. "us"'),
        language: z
          .string()
          .describe('Language-locale code of the market, e.g. "en-US"'),
        startDate: z
          .string()
          .optional()
          .describe('Start of the range, YYYY-MM-DD (default: 3 months ago)'),
        endDate: z
          .string()
          .optional()
          .describe('End of the range, YYYY-MM-DD (default: today)'),
        related: z
          .boolean()
          .optional()
          .describe(
            'true → related keywords with volumes instead of the exact term',
          ),
      },
    },
    run(
      async ({
        q,
        country,
        language,
        startDate,
        endDate,
        related = false,
      }) => {
        if (!q?.trim()) {
          throw new BingInputError('`q` must be a non-empty keyword');
        }
        if (!country?.trim() || !language?.trim()) {
          throw new BingInputError(
            '`country` and `language` are required (e.g. "us" and "en-US"); ask the user which market they mean if unsure',
          );
        }
        if (startDate !== undefined) assertIsoDate(startDate, 'startDate');
        if (endDate !== undefined) assertIsoDate(endDate, 'endDate');
        const end = endDate ?? isoDay(new Date());
        const start =
          startDate ?? isoDay(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
        if (start > end) {
          throw new BingInputError(
            `\`startDate\` (${start}) must not be after \`endDate\` (${end})`,
          );
        }
        const bing = await getClient();
        const data = related
          ? await bing.getRelatedKeywords(q, country, language, start, end)
          : await bing.getKeyword(q, country, language, start, end);
        return JSON.stringify(
          {
            q,
            country,
            language,
            startDate: start,
            endDate: end,
            related,
            data,
          },
          null,
          2,
        );
      },
    ),
  );

  server.registerTool(
    'backlinks',
    {
      description:
        'Inbound links Bing knows for the site: without `url`, per-page inbound-link ' +
        'counts; with `url`, the actual linking pages and anchor texts for that URL. ' +
        'Results are paginated via `page`.',
      inputSchema: {
        siteUrl: siteUrlInput,
        url: z
          .string()
          .optional()
          .describe('Optional page of the site to list the inbound links of'),
        page: z
          .number()
          .int()
          .optional()
          .describe('Result page, 0-based (default 0)'),
      },
    },
    run(async ({ siteUrl, url, page = 0 }) => {
      if (!Number.isInteger(page) || page < 0) {
        throw new BingInputError(
          `\`page\` must be a non-negative integer, got: ${page}`,
        );
      }
      const site = resolveSiteUrl(siteUrl, env);
      const bing = await getClient();
      if (url === undefined) {
        const counts = await bing.getLinkCounts(site, page);
        return JSON.stringify({ siteUrl: site, page, ...counts }, null, 2);
      }
      requireHttpUrl(url);
      const links = await bing.getUrlLinks(site, url, page);
      return JSON.stringify({ siteUrl: site, url, page, ...links }, null, 2);
    }),
  );

  return server;
}

// npm installs the bin as a symlink, so compare real paths: argv[1] is the
// link, import.meta.url the target.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  await createServer().connect(new StdioServerTransport());
}
