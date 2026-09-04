import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BingInputError,
  BingSetupError,
  MAX_BATCH_URLS,
  assertIsoDate,
  assertSameOrigin,
  buildIndexNowPayload,
  indexNowKeyFromFile,
  missingKeyMessage,
  parseMsJsonDate,
  resolveSiteUrl,
  shapeApiValue,
  siteOrigin,
  validateUrlBatch,
} from '../lib.mjs';

const ENV = { BING_SITE_URL: 'https://www.example.com/' };

test('resolveSiteUrl: env default, explicit override, setup error when neither', () => {
  assert.equal(
    resolveSiteUrl(undefined, ENV),
    'https://www.example.com/',
  );
  assert.equal(
    resolveSiteUrl('https://other.example/', ENV),
    'https://other.example/',
  );
  assert.throws(() => resolveSiteUrl(undefined, {}), BingSetupError);
  assert.throws(() => resolveSiteUrl(undefined, {}), /BING_SITE_URL/);
});

test('assertIsoDate: accepts real dates, rejects malformed and impossible ones', () => {
  assert.doesNotThrow(() => assertIsoDate('2026-07-29', 'startDate'));
  assert.throws(() => assertIsoDate('julio', 'startDate'), /startDate/);
  assert.throws(() => assertIsoDate('2026-02-30', 'endDate'), /endDate/);
  assert.throws(() => assertIsoDate(undefined, 'startDate'), BingInputError);
});

test('parseMsJsonDate: WCF /Date(ms)/ becomes ISO, other values pass through', () => {
  assert.equal(
    parseMsJsonDate('/Date(1610236800000)/'),
    '2021-01-10T00:00:00.000Z',
  );
  assert.equal(
    parseMsJsonDate('/Date(1610236800000-0800)/'),
    '2021-01-10T00:00:00.000Z',
  );
  assert.equal(parseMsJsonDate('hola'), 'hola');
  assert.equal(parseMsJsonDate(42), 42);
  assert.equal(parseMsJsonDate(null), null);
});

test('shapeApiValue: converts dates recursively and drops __type noise', () => {
  const shaped = shapeApiValue({
    __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api',
    Query: 'coffee shop',
    Impressions: 120,
    Date: '/Date(1751328000000)/',
    Nested: [{ __type: 'x', When: '/Date(1610236800000)/' }],
  });
  assert.deepEqual(shaped, {
    Query: 'coffee shop',
    Impressions: 120,
    Date: '2025-07-01T00:00:00.000Z',
    Nested: [{ When: '2021-01-10T00:00:00.000Z' }],
  });
});

test('siteOrigin: extracts the origin, rejects non-http site URLs', () => {
  assert.equal(
    siteOrigin('https://www.example.com/'),
    'https://www.example.com',
  );
  assert.throws(() => siteOrigin('not-a-url'), BingInputError);
});

test('assertSameOrigin: accepts own URLs, names the offender otherwise', () => {
  const site = 'https://www.example.com/';
  assert.doesNotThrow(() =>
    assertSameOrigin(
      ['https://www.example.com/pages/one/'],
      site,
    ),
  );
  assert.throws(
    () => assertSameOrigin(['https://evil.example/x'], site),
    /evil\.example/,
  );
  assert.throws(() => assertSameOrigin(['nope'], site), BingInputError);
});

test('assertSameOrigin: an apex site covers its subdomains (Bing domain property)', () => {
  const apex = 'https://example.com/';
  assert.doesNotThrow(() =>
    assertSameOrigin(['https://www.example.com/pages/'], apex),
  );
  // …but not lookalike domains, and never across schemes.
  assert.throws(
    () => assertSameOrigin(['https://notexample.com/'], apex),
    /notexample\.com/,
  );
  assert.throws(
    () => assertSameOrigin(['http://www.example.com/'], apex),
    BingInputError,
  );
  // A www site does NOT cover the apex — subdomain scoping is one-way.
  assert.throws(
    () =>
      assertSameOrigin(
        ['https://example.com/'],
        'https://www.example.com/',
      ),
    BingInputError,
  );
});

test('validateUrlBatch: rejects empty and oversized batches', () => {
  assert.throws(() => validateUrlBatch([]), /at least one/i);
  const many = Array.from({ length: MAX_BATCH_URLS + 1 }, (_, i) => `u${i}`);
  assert.throws(
    () => validateUrlBatch(many),
    new RegExp(String(MAX_BATCH_URLS)),
  );
  assert.doesNotThrow(() => validateUrlBatch(['https://a.example/']));
});

test('indexNowKeyFromFile: key must match its file name and be well-formed', () => {
  assert.equal(
    indexNowKeyFromFile('abc123DEF.txt', 'abc123DEF\n'),
    'abc123DEF',
  );
  assert.throws(
    () => indexNowKeyFromFile('abc.txt', 'other-key'),
    BingSetupError,
  );
  assert.throws(
    () => indexNowKeyFromFile('ab.txt', 'ab'),
    /at least 8/i,
  );
  assert.throws(
    () => indexNowKeyFromFile('bad key!.txt', 'bad key!'),
    BingSetupError,
  );
});

test('buildIndexNowPayload: host + keyLocation derived from the site, URLs checked', () => {
  const payload = buildIndexNowPayload({
    siteUrl: 'https://www.example.com/',
    key: 'abc123DEF456',
    urls: ['https://www.example.com/news/new/'],
  });
  assert.deepEqual(payload, {
    host: 'www.example.com',
    key: 'abc123DEF456',
    keyLocation: 'https://www.example.com/abc123DEF456.txt',
    urlList: ['https://www.example.com/news/new/'],
  });
  assert.throws(
    () =>
      buildIndexNowPayload({
        siteUrl: 'https://www.example.com/',
        key: 'abc123DEF456',
        urls: ['https://evil.example/'],
      }),
    /evil\.example/,
  );
});

test('missingKeyMessage: actionable portal steps naming the env var', () => {
  const message = missingKeyMessage('/keys/bing-api-key.txt');
  assert.match(message, /BING_API_KEY_FILE/);
  assert.match(message, /bing\.com\/webmasters/i);
  assert.match(message, /API Access/i);
  assert.match(message, /\/keys\/bing-api-key\.txt/);
  assert.match(message, /BING_API_KEY\b/);
});
