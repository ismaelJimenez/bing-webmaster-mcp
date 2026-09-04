// Thin wrapper over the Bing Webmaster Tools JSON API and the IndexNow
// protocol. This is the only file that talks to the network; server.mjs
// receives both factories so tests can swap in fakes.

import { readFileSync } from 'node:fs';

import {
  BingSetupError,
  indexNowKeyFromFile,
  buildIndexNowPayload,
  missingKeyMessage,
  shapeApiValue,
} from './lib.mjs';

const API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

export function readApiKey({ keyFile, env = process.env } = {}) {
  const fromEnv = env.BING_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (!keyFile) {
    throw new BingSetupError(missingKeyMessage('(BING_API_KEY_FILE not set)'));
  }
  let content;
  try {
    content = readFileSync(keyFile, 'utf8');
  } catch {
    throw new BingSetupError(missingKeyMessage(keyFile));
  }
  const key = content.trim();
  if (!key) throw new BingSetupError(missingKeyMessage(keyFile));
  return key;
}

class BingApiError extends Error {
  name = 'BingApiError';
}

async function raiseForStatus(response, operation) {
  if (response.ok) return;
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    throw new BingApiError(
      `Bing API rate limit hit on ${operation} (HTTP 429)` +
        (retryAfter ? ` — retry after ${retryAfter}s` : ' — retry shortly'),
    );
  }
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.Message ?? body?.d?.Message ?? JSON.stringify(body);
  } catch {
    detail = '(no response body)';
  }
  throw new BingApiError(
    `Bing API ${operation} failed (HTTP ${response.status}): ${detail}`,
  );
}

export function createBingClient({
  keyFile,
  apiKey,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const key = apiKey ?? readApiKey({ keyFile, env });

  const get = async (operation, params = {}) => {
    const url = new URL(`${API_BASE}/${operation}`);
    url.searchParams.set('apikey', key);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    const response = await fetchImpl(url.toString(), { method: 'GET' });
    await raiseForStatus(response, operation);
    const body = await response.json();
    return shapeApiValue(body?.d);
  };

  const post = async (operation, payload) => {
    const response = await fetchImpl(`${API_BASE}/${operation}?apikey=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    await raiseForStatus(response, operation);
    const body = await response.json().catch(() => ({ d: null }));
    return shapeApiValue(body?.d);
  };

  return {
    getUserSites: () => get('GetUserSites'),
    getQueryStats: (siteUrl) => get('GetQueryStats', { siteUrl }),
    getPageStats: (siteUrl) => get('GetPageStats', { siteUrl }),
    getRankAndTrafficStats: (siteUrl) =>
      get('GetRankAndTrafficStats', { siteUrl }),
    getCrawlStats: (siteUrl) => get('GetCrawlStats', { siteUrl }),
    getCrawlIssues: (siteUrl) => get('GetCrawlIssues', { siteUrl }),
    getFeeds: (siteUrl) => get('GetFeeds', { siteUrl }),
    submitFeed: (siteUrl, feedUrl) => post('SubmitFeed', { siteUrl, feedUrl }),
    removeFeed: (siteUrl, feedUrl) => post('RemoveFeed', { siteUrl, feedUrl }),
    getUrlInfo: (siteUrl, url) => get('GetUrlInfo', { siteUrl, url }),
    getUrlSubmissionQuota: (siteUrl) =>
      get('GetUrlSubmissionQuota', { siteUrl }),
    submitUrlBatch: (siteUrl, urlList) =>
      post('SubmitUrlBatch', { siteUrl, urlList }),
    getKeyword: (q, country, language, startDate, endDate) =>
      get('GetKeyword', { q, country, language, startDate, endDate }),
    getRelatedKeywords: (q, country, language, startDate, endDate) =>
      get('GetRelatedKeywords', { q, country, language, startDate, endDate }),
    getLinkCounts: (siteUrl, page) => get('GetLinkCounts', { siteUrl, page }),
    getUrlLinks: (siteUrl, link, page) =>
      get('GetUrlLinks', { siteUrl, link, page }),
  };
}

export function createIndexNow({
  keyFile,
  key,
  siteUrl,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  let resolvedKey = key;
  if (!resolvedKey) {
    if (!keyFile) {
      throw new BingSetupError(
        'IndexNow key not available: set the INDEXNOW_KEY_FILE environment ' +
          'variable to your key file (<key>.txt). The same file must be ' +
          'publicly hosted at the site root — that is how engines verify ' +
          'ownership, so the key is not a secret.',
      );
    }
    let content;
    try {
      content = readFileSync(keyFile, 'utf8');
    } catch {
      throw new BingSetupError(
        `IndexNow key file not readable: ${keyFile}. Generate a key (8–128 ` +
          'characters of [a-zA-Z0-9-]), save it as <key>.txt, host that file at ' +
          'the site root, and point INDEXNOW_KEY_FILE at your local copy.',
      );
    }
    resolvedKey = indexNowKeyFromFile(keyFile, content);
  }

  const probe = buildIndexNowPayload({ siteUrl, key: resolvedKey, urls: [] });

  return {
    keyLocation: probe.keyLocation,
    async submit(urlList) {
      const payload = buildIndexNowPayload({
        siteUrl,
        key: resolvedKey,
        urls: urlList,
      });
      const response = await fetchImpl(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
      if (response.status >= 400) {
        throw new BingApiError(
          `IndexNow submission failed (HTTP ${response.status}) — 403 means ` +
            `the key file is not reachable at ${probe.keyLocation} (deploy it first)`,
        );
      }
      return { status: response.status };
    },
  };
}

export function bingErrorMessage(err) {
  return err?.message ?? String(err);
}
