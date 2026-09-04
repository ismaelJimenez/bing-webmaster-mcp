import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../server.mjs';
import { BingSetupError, missingKeyMessage } from '../lib.mjs';

const SITE = 'https://www.example.com/';
const ENV = {
  BING_API_KEY_FILE: '/fake/bing-api-key.txt',
  BING_SITE_URL: SITE,
  INDEXNOW_KEY_FILE: 'abc123DEF456.txt',
};

const ALL_TOOLS = [
  'backlinks',
  'crawl_issues',
  'crawl_stats',
  'indexnow',
  'keyword_research',
  'list_sitemaps',
  'list_sites',
  'page_stats',
  'query_stats',
  'rank_traffic_stats',
  'remove_sitemap',
  'submit_sitemap',
  'submit_urls',
  'url_info',
];

/** Fake of the bing.mjs client — records calls, returns canned data. */
function fakeClient(overrides = {}) {
  const calls = [];
  const record =
    (name, result) =>
    async (...args) => {
      calls.push({ name, args });
      if (overrides[name] instanceof Error) throw overrides[name];
      return overrides[name] ?? result;
    };
  return {
    calls,
    getUserSites: record('getUserSites', [{ Url: SITE, IsVerified: true }]),
    getQueryStats: record('getQueryStats', [
      { Query: 'coffee shop', Impressions: 100, Clicks: 5 },
    ]),
    getPageStats: record('getPageStats', [
      { Query: '/pages/', Impressions: 40 },
    ]),
    getRankAndTrafficStats: record('getRankAndTrafficStats', [
      { Date: '2026-07-01T00:00:00.000Z', Impressions: 10, Clicks: 1 },
    ]),
    getCrawlStats: record('getCrawlStats', [
      { Date: '2026-07-01T00:00:00.000Z', CrawledPages: 12 },
    ]),
    getCrawlIssues: record('getCrawlIssues', [
      { Url: `${SITE}broken/`, HttpCode: 404 },
    ]),
    getFeeds: record('getFeeds', [
      { Url: `${SITE}sitemap-index.xml`, Status: 'Processed' },
    ]),
    submitFeed: record('submitFeed', null),
    removeFeed: record('removeFeed', null),
    getUrlInfo: record('getUrlInfo', {
      Url: SITE,
      HttpStatus: 200,
      LastCrawledDate: '2026-07-20T00:00:00.000Z',
    }),
    getUrlSubmissionQuota: record('getUrlSubmissionQuota', {
      DailyQuota: 100,
      MonthlyQuota: 3000,
    }),
    submitUrlBatch: record('submitUrlBatch', null),
    getKeyword: record('getKeyword', { Query: 'coffee', Impressions: 900 }),
    getRelatedKeywords: record('getRelatedKeywords', [
      { Query: 'best coffee shop', Impressions: 300 },
    ]),
    getLinkCounts: record('getLinkCounts', {
      Links: [{ Url: SITE, Count: 12 }],
      TotalPages: 1,
    }),
    getUrlLinks: record('getUrlLinks', {
      Links: [{ Url: 'https://blog.example/post', AnchorText: 'directorio' }],
      TotalPages: 1,
    }),
  };
}

function fakeIndexNow() {
  const calls = [];
  return {
    calls,
    keyLocation: 'https://www.example.com/abc123DEF456.txt',
    async submit(urlList) {
      calls.push(urlList);
      return { status: 202 };
    },
  };
}

async function connect({
  env = ENV,
  client = fakeClient(),
  indexNow = fakeIndexNow(),
} = {}) {
  const server = createServer({
    env,
    clientFactory: async () => client,
    indexNowFactory: async () => indexNow,
  });
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
  return { mcpClient, client, indexNow };
}

function textOf(result) {
  return result.content.map((c) => c.text).join('\n');
}

test('registers exactly the fourteen tools', async () => {
  const { mcpClient } = await connect();
  const { tools } = await mcpClient.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);
  for (const tool of tools) assert.ok(tool.description.length > 10, tool.name);
});

test('query_stats: rows against the default property; siteUrl overrides', async () => {
  const { mcpClient, client } = await connect();
  const result = await mcpClient.callTool({
    name: 'query_stats',
    arguments: {},
  });
  assert.ok(!result.isError, textOf(result));
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.siteUrl, SITE);
  assert.equal(payload.rows[0].Query, 'coffee shop');
  assert.deepEqual(client.calls[0], { name: 'getQueryStats', args: [SITE] });

  await mcpClient.callTool({
    name: 'query_stats',
    arguments: { siteUrl: 'https://other.example/' },
  });
  assert.equal(client.calls[1].args[0], 'https://other.example/');
});

test('url_info requires a fully-qualified URL', async () => {
  const { mcpClient, client } = await connect();
  const result = await mcpClient.callTool({
    name: 'url_info',
    arguments: { url: 'pages/kumon' },
  });
  assert.ok(result.isError);
  assert.match(textOf(result), /url/);
  assert.equal(client.calls.length, 0);
});

test('submit_urls: same-origin enforced before any network call', async () => {
  const { mcpClient, client } = await connect();
  const result = await mcpClient.callTool({
    name: 'submit_urls',
    arguments: { urls: ['https://evil.example/spam'] },
  });
  assert.ok(result.isError);
  assert.match(textOf(result), /evil\.example/);
  assert.equal(client.calls.length, 0, 'must not reach the Bing client');
});

test('submit_urls: success response includes the remaining quota', async () => {
  const { mcpClient, client } = await connect();
  const result = await mcpClient.callTool({
    name: 'submit_urls',
    arguments: { urls: [`${SITE}pages/new/`] },
  });
  assert.ok(!result.isError, textOf(result));
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.submitted, 1);
  assert.deepEqual(payload.remainingQuota, {
    DailyQuota: 100,
    MonthlyQuota: 3000,
  });
  assert.deepEqual(
    client.calls.map((c) => c.name),
    ['submitUrlBatch', 'getUrlSubmissionQuota'],
  );
});

test('indexnow: same-origin enforced; success reports status and count', async () => {
  const { mcpClient, indexNow } = await connect();

  const bad = await mcpClient.callTool({
    name: 'indexnow',
    arguments: { urls: ['https://evil.example/'] },
  });
  assert.ok(bad.isError);
  assert.equal(indexNow.calls.length, 0);

  const good = await mcpClient.callTool({
    name: 'indexnow',
    arguments: { urls: [`${SITE}news/new/`] },
  });
  assert.ok(!good.isError, textOf(good));
  const payload = JSON.parse(textOf(good));
  assert.equal(payload.status, 202);
  assert.equal(payload.submitted, 1);
  assert.deepEqual(indexNow.calls, [[`${SITE}news/new/`]]);
});

test('indexnow: INDEXNOW_SITE_URL governs the key and origin check, not the Bing property', async () => {
  // Real setup: the Bing property is the apex domain, the deployed site is www.
  const env = {
    ...ENV,
    BING_SITE_URL: 'https://example.com/',
    INDEXNOW_SITE_URL: 'https://www.example.com/',
  };
  const indexNow = fakeIndexNow();
  let factoryArgs;
  const server = createServer({
    env,
    clientFactory: async () => fakeClient(),
    indexNowFactory: async (args) => {
      factoryArgs = args;
      return indexNow;
    },
  });
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), mcpClient.connect(ct)]);

  // The apex URL is NOT on the www host that serves the key file → rejected.
  const bad = await mcpClient.callTool({
    name: 'indexnow',
    arguments: { urls: ['https://example.com/pages/'] },
  });
  assert.ok(bad.isError);

  const good = await mcpClient.callTool({
    name: 'indexnow',
    arguments: { urls: ['https://www.example.com/pages/'] },
  });
  assert.ok(!good.isError, textOf(good));
  assert.equal(factoryArgs.siteUrl, 'https://www.example.com/');
});

test('submit_urls: www URLs pass against the apex Bing property', async () => {
  const env = { ...ENV, BING_SITE_URL: 'https://example.com/' };
  const { mcpClient, client } = await connect({ env });
  const result = await mcpClient.callTool({
    name: 'submit_urls',
    arguments: { urls: ['https://www.example.com/pages/new/'] },
  });
  assert.ok(!result.isError, textOf(result));
  assert.equal(client.calls[0].name, 'submitUrlBatch');
});

test('keyword_research: passes market through, related flag switches operation', async () => {
  const { mcpClient, client } = await connect();
  await mcpClient.callTool({
    name: 'keyword_research',
    arguments: { q: 'coffee', country: 'us', language: 'en-US' },
  });
  const call = client.calls[0];
  assert.equal(call.name, 'getKeyword');
  const [q, country, language, startDate, endDate] = call.args;
  assert.equal(q, 'coffee');
  assert.equal(country, 'us');
  assert.equal(language, 'en-US');
  assert.match(startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(startDate < endDate);

  await mcpClient.callTool({
    name: 'keyword_research',
    arguments: { q: 'coffee', country: 'us', language: 'en-US', related: true },
  });
  assert.equal(client.calls[1].name, 'getRelatedKeywords');
});

test('keyword_research: country and language are required', async () => {
  const { mcpClient, client } = await connect();
  const result = await mcpClient.callTool({
    name: 'keyword_research',
    arguments: { q: 'coffee' },
  });
  assert.ok(result.isError);
  assert.match(textOf(result), /country/);
  assert.equal(client.calls.length, 0);
});

test('keyword_research: invalid explicit date errors before the client', async () => {
  const { mcpClient, client } = await connect();
  const result = await mcpClient.callTool({
    name: 'keyword_research',
    arguments: { q: 'coffee', country: 'us', language: 'en-US', startDate: 'June' },
  });
  assert.ok(result.isError);
  assert.match(textOf(result), /startDate/);
  assert.equal(client.calls.length, 0);
});

test('backlinks: site-wide counts without url, linking pages with url', async () => {
  const { mcpClient, client } = await connect();
  const counts = await mcpClient.callTool({ name: 'backlinks', arguments: {} });
  assert.ok(!counts.isError, textOf(counts));
  assert.equal(client.calls[0].name, 'getLinkCounts');
  assert.deepEqual(client.calls[0].args, [SITE, 0]);

  await mcpClient.callTool({
    name: 'backlinks',
    arguments: { url: `${SITE}pages/one/`, page: 2 },
  });
  assert.equal(client.calls[1].name, 'getUrlLinks');
  assert.deepEqual(client.calls[1].args, [
    SITE,
    `${SITE}pages/one/`,
    2,
  ]);
});

test('sitemap tools: list, submit and remove against the default property', async () => {
  const { mcpClient, client } = await connect();
  const feedUrl = `${SITE}sitemap-index.xml`;

  const list = await mcpClient.callTool({
    name: 'list_sitemaps',
    arguments: {},
  });
  assert.ok(!list.isError, textOf(list));
  assert.match(textOf(list), /sitemap-index\.xml/);

  const submit = await mcpClient.callTool({
    name: 'submit_sitemap',
    arguments: { feedUrl },
  });
  assert.ok(!submit.isError, textOf(submit));

  const removed = await mcpClient.callTool({
    name: 'remove_sitemap',
    arguments: { feedUrl },
  });
  assert.ok(!removed.isError, textOf(removed));

  assert.deepEqual(
    client.calls.map((c) => c.name),
    ['getFeeds', 'submitFeed', 'removeFeed'],
  );
  assert.deepEqual(client.calls[1].args, [SITE, feedUrl]);
});

test('missing API key: tools answer with setup instructions, no crash', async () => {
  const server = createServer({
    env: { BING_SITE_URL: SITE },
    clientFactory: async () => {
      throw new BingSetupError(
        missingKeyMessage('(BING_API_KEY_FILE not set)'),
      );
    },
    indexNowFactory: async () => fakeIndexNow(),
  });
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), mcpClient.connect(ct)]);
  const result = await mcpClient.callTool({
    name: 'list_sites',
    arguments: {},
  });
  assert.ok(result.isError);
  assert.match(textOf(result), /BING_API_KEY_FILE/);
  assert.match(textOf(result), /API Access/i);
});

test('Bing API errors surface as tool errors, not crashes', async () => {
  const boom = new Error('InvalidApiKey (Bing HTTP 400)');
  const { mcpClient } = await connect({
    client: fakeClient({ getUserSites: boom }),
  });
  const result = await mcpClient.callTool({
    name: 'list_sites',
    arguments: {},
  });
  assert.ok(result.isError);
  assert.match(textOf(result), /InvalidApiKey/);
});
