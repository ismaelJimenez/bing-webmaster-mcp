import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BingSetupError } from '../lib.mjs';
import {
  bingErrorMessage,
  createBingClient,
  createIndexNow,
  readApiKey,
} from '../bing.mjs';

/** fetch stub that records requests and returns canned responses in order. */
function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 200, body: { d: null } };
    return {
      ok: next.status < 400,
      status: next.status,
      headers: { get: (name) => next.headers?.[name.toLowerCase()] },
      async json() {
        return next.body;
      },
      async text() {
        return JSON.stringify(next.body);
      },
    };
  };
  impl.calls = calls;
  return impl;
}

test('readApiKey: BING_API_KEY env overrides, missing file is a setup error', () => {
  assert.equal(readApiKey({ env: { BING_API_KEY: ' k123 ' } }), 'k123');
  assert.throws(
    () => readApiKey({ keyFile: '/nonexistent/bing.txt', env: {} }),
    BingSetupError,
  );
  assert.throws(() => readApiKey({ env: {} }), /BING_API_KEY_FILE/);
});

test('GET operations: apikey + params in the query string, d unwrapped, dates shaped', async () => {
  const fetchImpl = fakeFetch({
    status: 200,
    body: {
      d: [
        { Query: 'coffee shop', Impressions: 9, Date: '/Date(1751328000000)/' },
      ],
    },
  });
  const client = createBingClient({ apiKey: 'K', fetchImpl });
  const rows = await client.getQueryStats('https://www.example.com/');

  const { url, init } = fetchImpl.calls[0];
  assert.match(
    url,
    /^https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/GetQueryStats\?/,
  );
  assert.match(url, /apikey=K/);
  assert.match(url, /siteUrl=https%3A%2F%2Fwww\.example\.com%2F/);
  assert.equal(init.method ?? 'GET', 'GET');
  assert.deepEqual(rows, [
    { Query: 'coffee shop', Impressions: 9, Date: '2025-07-01T00:00:00.000Z' },
  ]);
});

test('POST operations: JSON body with UTF-8 content type', async () => {
  const fetchImpl = fakeFetch({ status: 200, body: { d: null } });
  const client = createBingClient({ apiKey: 'K', fetchImpl });
  await client.submitUrlBatch('https://site.example/', [
    'https://site.example/a/',
  ]);

  const { url, init } = fetchImpl.calls[0];
  assert.match(url, /\/json\/SubmitUrlBatch\?apikey=K$/);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(init.body), {
    siteUrl: 'https://site.example/',
    urlList: ['https://site.example/a/'],
  });
});

test('keyword operations pass q/country/language/date params', async () => {
  const fetchImpl = fakeFetch({
    status: 200,
    body: { d: { Query: 'coffee' } },
  });
  const client = createBingClient({ apiKey: 'K', fetchImpl });
  await client.getKeyword(
    'coffee',
    'us',
    'en-US',
    '2026-06-01',
    '2026-07-01',
  );
  const { url } = fetchImpl.calls[0];
  assert.match(url, /GetKeyword\?/);
  assert.match(url, /q=coffee/);
  assert.match(url, /country=us/);
  assert.match(url, /language=en-US/);
  assert.match(url, /startDate=2026-06-01/);
  assert.match(url, /endDate=2026-07-01/);
});

test('API errors surface the Bing message; 429 names the rate limit', async () => {
  const boom = createBingClient({
    apiKey: 'K',
    fetchImpl: fakeFetch({
      status: 400,
      body: { ErrorCode: 2, Message: 'InvalidApiKey' },
    }),
  });
  await assert.rejects(() => boom.getUserSites(), /InvalidApiKey/);

  const limited = createBingClient({
    apiKey: 'K',
    fetchImpl: fakeFetch({
      status: 429,
      headers: { 'retry-after': '30' },
      body: {},
    }),
  });
  await assert.rejects(() => limited.getUserSites(), /rate limit/i);
  await assert.rejects(
    () =>
      createBingClient({
        apiKey: 'K',
        fetchImpl: fakeFetch({
          status: 429,
          headers: { 'retry-after': '30' },
          body: {},
        }),
      }).getUserSites(),
    /30/,
  );
});

test('bingErrorMessage falls back to the generic message', () => {
  assert.equal(bingErrorMessage(new Error('boom')), 'boom');
  assert.equal(bingErrorMessage('raw'), 'raw');
});

test('createIndexNow: missing key file is a setup error naming INDEXNOW_KEY_FILE', () => {
  assert.throws(
    () => createIndexNow({ siteUrl: 'https://s.example/', env: {} }),
    /INDEXNOW_KEY_FILE/,
  );
  assert.throws(
    () =>
      createIndexNow({
        keyFile: '/nonexistent/abc.txt',
        siteUrl: 'https://s.example/',
        env: {},
      }),
    BingSetupError,
  );
});

test('indexNow.submit posts the protocol payload to api.indexnow.org', async () => {
  const fetchImpl = fakeFetch({ status: 202, body: {} });
  const indexNow = createIndexNow({
    siteUrl: 'https://www.example.com/',
    key: 'abc123DEF456',
    fetchImpl,
  });
  const result = await indexNow.submit([
    'https://www.example.com/news/new/',
  ]);
  assert.equal(result.status, 202);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.indexnow.org/indexnow');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), {
    host: 'www.example.com',
    key: 'abc123DEF456',
    keyLocation: 'https://www.example.com/abc123DEF456.txt',
    urlList: ['https://www.example.com/news/new/'],
  });
});

test('indexNow.submit surfaces non-2xx responses as errors', async () => {
  const indexNow = createIndexNow({
    siteUrl: 'https://www.example.com/',
    key: 'abc123DEF456',
    fetchImpl: fakeFetch({ status: 403, body: {} }),
  });
  await assert.rejects(
    () => indexNow.submit(['https://www.example.com/']),
    /403/,
  );
});
