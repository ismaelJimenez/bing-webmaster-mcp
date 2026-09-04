// Pure helpers for the Bing Webmaster MCP server : input
// validation and response shaping. No I/O here — everything is
// unit-testable offline.

/** A configuration/usage problem the caller can fix (vs a Bing API failure). */
export class BingSetupError extends Error {
  name = 'BingSetupError';
}

export class BingInputError extends Error {
  name = 'BingInputError';
}

export const MAX_BATCH_URLS = 500;

export function resolveSiteUrl(siteUrl, env) {
  const resolved = siteUrl ?? env.BING_SITE_URL;
  if (!resolved) {
    throw new BingSetupError(
      'No site given: pass `siteUrl` or set the BING_SITE_URL environment ' +
        'variable (e.g. `https://www.example.com/`).',
    );
  }
  return resolved;
}

export function assertIsoDate(value, field) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) {
    throw new BingInputError(
      `\`${field}\` must be an ISO date (YYYY-MM-DD), got: ${JSON.stringify(value)}`,
    );
  }
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!roundTrips) {
    throw new BingInputError(
      `\`${field}\` is not a real calendar date: ${value}`,
    );
  }
}

// The api.svc JSON endpoint serializes DateTime as WCF "/Date(ms[±zzzz])/".
// The milliseconds are the UTC instant; the optional offset is display-only.
const MS_JSON_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;

export function parseMsJsonDate(value) {
  if (typeof value !== 'string') return value;
  const match = MS_JSON_DATE.exec(value);
  if (!match) return value;
  return new Date(Number(match[1])).toISOString();
}

/** Recursively convert WCF dates and drop the serializer's `__type` tags. */
export function shapeApiValue(value) {
  if (Array.isArray(value)) return value.map(shapeApiValue);
  if (value !== null && typeof value === 'object') {
    const shaped = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__type') continue;
      shaped[key] = shapeApiValue(entry);
    }
    return shaped;
  }
  return parseMsJsonDate(value);
}

export function siteOrigin(siteUrl) {
  let parsed;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new BingInputError(
      `site URL is not a valid URL: ${JSON.stringify(siteUrl)}`,
    );
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new BingInputError(
      `site URL must be http(s), got: ${JSON.stringify(siteUrl)}`,
    );
  }
  return parsed.origin;
}

export function assertSameOrigin(urls, siteUrl) {
  const origin = siteOrigin(siteUrl);
  const site = new URL(origin);
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new BingInputError(
        `\`urls\` contains an invalid URL: ${JSON.stringify(url)}`,
      );
    }
    // Bing properties can be domain-scoped (registered on the apex), so a
    // subdomain of the site host also belongs to it. One-way: an apex covers
    // www, a www site never covers the apex.
    const sameSite =
      parsed.protocol === site.protocol &&
      (parsed.hostname === site.hostname ||
        parsed.hostname.endsWith(`.${site.hostname}`));
    if (!sameSite) {
      throw new BingInputError(
        `\`urls\` contains a URL outside the site (${origin}): ${url}`,
      );
    }
  }
}

export function validateUrlBatch(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new BingInputError('`urls` must contain at least one URL');
  }
  if (urls.length > MAX_BATCH_URLS) {
    throw new BingInputError(
      `\`urls\` accepts at most ${MAX_BATCH_URLS} URLs per call, got: ${urls.length}`,
    );
  }
}

// IndexNow keys: 8–128 chars of [a-zA-Z0-9-], hosted at <origin>/<key>.txt.
const INDEXNOW_KEY = /^[a-zA-Z0-9-]{8,128}$/;

export function indexNowKeyFromFile(filePath, content) {
  const key = (content ?? '').trim();
  if (key.length < 8 || !INDEXNOW_KEY.test(key)) {
    throw new BingSetupError(
      `IndexNow key in ${filePath} must be at least 8 characters of ` +
        `[a-zA-Z0-9-], got: ${JSON.stringify(key)}`,
    );
  }
  const fileName = filePath.split('/').pop();
  if (fileName !== `${key}.txt`) {
    throw new BingSetupError(
      `IndexNow key file must be named <key>.txt so engines can verify it: ` +
        `${filePath} does not match its content (expected ${key}.txt)`,
    );
  }
  return key;
}

export function buildIndexNowPayload({ siteUrl, key, urls }) {
  assertSameOrigin(urls, siteUrl);
  const origin = siteOrigin(siteUrl);
  return {
    host: new URL(origin).host,
    key,
    keyLocation: `${origin}/${key}.txt`,
    urlList: urls,
  };
}

export function missingKeyMessage(keyFile) {
  return [
    `Bing Webmaster Tools credentials not available: no readable API key at ${keyFile}.`,
    '',
    'One-time setup:',
    '  1. Sign in to https://www.bing.com/webmasters with the account that owns the verified site.',
    '  2. Open Settings → API Access, accept the terms and click Generate API Key (one key per user, valid for all verified sites).',
    '  3. Set the BING_API_KEY environment variable to the key, or save it in a file outside version control and point BING_API_KEY_FILE at it (BING_API_KEY overrides the file).',
  ].join('\n');
}
