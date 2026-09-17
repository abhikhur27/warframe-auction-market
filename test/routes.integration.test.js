const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMarketApiClient } = require('../market-api-client');
const { createApp } = require('../server');
const { createSnapshotStore } = require('../snapshot-store');

const fixtureDir = path.join(__dirname, 'fixtures', 'market-v2');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function fixtureResponse(body, status = 200, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalizedHeaders.get(name.toLowerCase()) || null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function createFixtureFetch(requests, overrides = {}) {
  const fixtures = new Map([
    ['/items', overrides.items || 'items.json'],
    ['/orders/recent', overrides.recentOrders || 'recent-orders.json'],
    ['/orders/item/arcane_energize', 'arcane-energize-orders.json'],
    ['/orders/item/blind_rage', 'blind-rage-orders.json'],
    ['/orders/item/adaptation', 'invalid-collection.json'],
    ['/orders/item/kuva_bramma_riven_mod', 'ranked-subtype-orders.json'],
  ]);
  const attempts = new Map();

  return async (url, options) => {
    const pathname = new URL(url).pathname.replace('/v2', '');
    const attempt = (attempts.get(pathname) || 0) + 1;
    attempts.set(pathname, attempt);
    requests.push({ pathname, headers: options.headers });
    let route = overrides.routes?.[pathname] || fixtures.get(pathname);
    if (Array.isArray(route)) route = route[Math.min(attempt - 1, route.length - 1)];

    if (route?.abort) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('Synthetic upstream timeout');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    if (route?.invalidJson) {
      return {
        ...fixtureResponse(null),
        json: async () => { throw new SyntaxError('Synthetic malformed JSON'); },
      };
    }
    if (route && typeof route === 'object') {
      const body = route.fixture ? readFixture(route.fixture) : route.body;
      return fixtureResponse(body, route.status || 200, route.headers || {});
    }

    const fixtureName = route;
    if (!fixtureName) return fixtureResponse({ error: 'Synthetic fixture not found' }, 404);
    return fixtureResponse(readFixture(fixtureName));
  };
}

async function startFixtureApp(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warframe-routes-test-'));
  const requests = [];
  const marketApi = createMarketApiClient({
    fetchImpl: createFixtureFetch(requests, overrides),
    requestDelayMs: 0,
    maxAttempts: 1,
    ...(overrides.marketApiOptions || {}),
  });
  const snapshotStore = createSnapshotStore({
    snapshotFile: path.join(root, 'session-snapshots.json'),
  });
  const app = createApp({
    marketApi,
    snapshotStore,
    now: overrides.now || (() => new Date('2026-09-06T22:00:00.000Z')),
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
  };
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { response, body: await response.json() };
}

test('POST /api/analyze replays the external contract through snapshot read-back', async (t) => {
  const { baseUrl, requests } = await startFixtureApp(t);
  const { response, body } = await requestJson(baseUrl, '/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: ['arcane energize', 'missing fixture item'],
      platform: 'pc',
      language: 'en',
      crossplay: true,
      minReputation: 5,
      minSpread: 8,
      minRoiPct: 10,
      minExpectedProfit: 20,
      minConservativeProfit: 20,
      minLiquidityOffers: 2,
      maxAgeHours: 0,
    }),
  });

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.resolvedCount, 1);
  assert.deepEqual(body.unresolved, ['missing fixture item']);
  assert.equal(body.result.length, 1);
  assert.equal(body.result[0].item.slug, 'arcane_energize');
  assert.equal(body.result[0].expectedProfit, 30);
  assert.equal(body.errors.length, 0);
  assert.ok(body.snapshotId);

  const saved = await requestJson(baseUrl, `/api/snapshots/${body.snapshotId}`);
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.kind, 'analyze');
  assert.equal(saved.body.result[0].expectedProfit, 30);
  assert.deepEqual(requests.map((request) => request.pathname), [
    '/items',
    '/orders/item/arcane_energize',
  ]);
});

test('stale item catalog remains available through a bounded refresh outage', async (t) => {
  let clock = new Date('2026-09-06T22:00:00.000Z');
  const { baseUrl, requests } = await startFixtureApp(t, {
    now: () => clock,
    routes: {
      '/items': [
        'items.json',
        { status: 503, body: { error: 'synthetic catalog outage' } },
      ],
    },
  });

  const warm = await requestJson(baseUrl, '/api/items?q=arcane');
  assert.equal(warm.response.status, 200);
  assert.equal(warm.body.items[0].slug, 'arcane_energize');

  clock = new Date(clock.getTime() + (6 * 60 * 60 * 1000) + 1);
  const fallback = await requestJson(baseUrl, '/api/items?q=arcane');
  assert.equal(fallback.response.status, 200);
  assert.equal(fallback.body.items[0].slug, 'arcane_energize');

  const health = await requestJson(baseUrl, '/healthz');
  assert.equal(health.body.cacheLoaded, true);
  assert.equal(health.body.cacheStale, true);
  assert.deepEqual(health.body.cacheRefresh, {
    status: 'stale',
    lastAttemptAt: clock.getTime(),
    lastSuccessAt: new Date('2026-09-06T22:00:00.000Z').getTime(),
    lastFailureAt: clock.getTime(),
    lastFailureCode: 'MARKET_API_HTTP',
    retryInMs: 60_000,
  });
  assert.equal(requests.filter((request) => request.pathname === '/items').length, 2);

  await requestJson(baseUrl, '/api/items?q=blind');
  assert.equal(requests.filter((request) => request.pathname === '/items').length, 2);
});

test('POST /api/auto-find returns viable routes and records item-level schema failures', async (t) => {
  const { baseUrl, requests } = await startFixtureApp(t);
  const { response, body } = await requestJson(baseUrl, '/api/auto-find', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'xbox',
      language: 'en',
      crossplay: false,
      minReputation: 5,
      minSpread: 1,
      minRoiPct: 0,
      minExpectedProfit: 5,
      minConservativeProfit: 8,
      minLiquidityOffers: 1,
      maxAgeHours: 0,
      maxResults: 2,
    }),
  });

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.candidateCount, 3);
  assert.equal(body.scannedCount, 3);
  assert.deepEqual(body.result.map((route) => route.item.slug), [
    'arcane_energize',
    'blind_rage',
  ]);
  assert.deepEqual(body.errors, [{
    item: 'adaptation',
    error: 'Warframe Market response for /orders/item/adaptation did not contain a data array.',
    code: 'MARKET_API_INVALID_DATA',
  }]);

  const saved = await requestJson(baseUrl, `/api/snapshots/${body.snapshotId}`);
  assert.equal(saved.body.kind, 'auto-find');
  assert.equal(saved.body.errors[0].code, 'MARKET_API_INVALID_DATA');

  const health = await requestJson(baseUrl, '/healthz');
  assert.equal(health.body.failures, 1);
  assert.equal(health.body.requests, 5);
  const marketRequests = requests.filter((request) => request.pathname !== '/items');
  assert.ok(marketRequests.every((request) => (
    request.headers.platform === 'xbox'
      && request.headers.language === 'en'
      && request.headers.crossplay === 'false'
  )));
});

test('a fatal recent-order error returns 502 and does not archive a scan', async (t) => {
  const { baseUrl } = await startFixtureApp(t, { recentOrders: 'response-error.json' });
  const failed = await requestJson(baseUrl, '/api/auto-find', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxAgeHours: 0 }),
  });

  assert.equal(failed.response.status, 502);
  assert.equal(failed.body.code, 'MARKET_API_RESPONSE_ERROR');
  assert.equal(failed.body.attempts, 1);
  assert.match(failed.body.error, /fixture_maintenance/);

  const snapshots = await requestJson(baseUrl, '/api/snapshots');
  assert.deepEqual(snapshots.body.snapshots, []);
});

test('an exhausted recent-order rate limit returns bounded retry metadata without a snapshot', async (t) => {
  const sleeps = [];
  const { baseUrl } = await startFixtureApp(t, {
    routes: {
      '/orders/recent': {
        status: 429,
        body: { error: 'synthetic rate limit' },
        headers: { 'retry-after': '120' },
      },
    },
    marketApiOptions: {
      maxAttempts: 2,
      maxRetryDelayMs: 5,
      sleepImpl: async (ms) => sleeps.push(ms),
    },
  });
  const failed = await requestJson(baseUrl, '/api/auto-find', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxAgeHours: 0 }),
  });

  assert.equal(failed.response.status, 502);
  assert.equal(failed.body.code, 'MARKET_API_RATE_LIMITED');
  assert.equal(failed.body.upstreamStatus, 429);
  assert.equal(failed.body.attempts, 1);
  assert.equal(failed.body.retryAfterMs, 120_000);
  assert.deepEqual(sleeps, []);

  const snapshots = await requestJson(baseUrl, '/api/snapshots');
  assert.deepEqual(snapshots.body.snapshots, []);
});

test('localized catalog aliases resolve ranked subtype routes without merging variants', async (t) => {
  const { baseUrl, requests } = await startFixtureApp(t, { items: 'localized-items.json' });
  const { response, body } = await requestJson(baseUrl, '/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: ['Mod Riven Kuva Bramma'],
      platform: 'pc',
      language: 'fr',
      crossplay: true,
      minSpread: 10,
      minRoiPct: 10,
      minExpectedProfit: 20,
      minConservativeProfit: 20,
      minLiquidityOffers: 2,
      maxAgeHours: 0,
    }),
  });

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.resolvedCount, 1);
  assert.equal(body.result.length, 1);
  assert.equal(body.result[0].item.slug, 'kuva_bramma_riven_mod');
  assert.deepEqual(body.result[0].variant, {
    rank: 8,
    subtype: 'rolled',
    label: 'Rank 8 | Subtype rolled',
  });
  assert.equal(body.result[0].expectedProfit, 80);
  assert.equal(body.result[0].stressTest.conservativeExpectedProfit, 60);

  const itemRequest = requests.find((request) => request.pathname.includes('kuva_bramma'));
  assert.deepEqual(itemRequest.headers, {
    platform: 'pc',
    language: 'fr',
    crossplay: 'true',
  });
});

test('auto-find retries a bounded rate limit and archives malformed item JSON as a partial failure', async (t) => {
  const sleeps = [];
  const { baseUrl } = await startFixtureApp(t, {
    routes: {
      '/orders/item/arcane_energize': [
        { status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '0' } },
        'arcane-energize-orders.json',
      ],
      '/orders/item/adaptation': { invalidJson: true },
    },
    marketApiOptions: {
      maxAttempts: 2,
      maxRetryDelayMs: 5,
      sleepImpl: async (ms) => sleeps.push(ms),
    },
  });
  const { response, body } = await requestJson(baseUrl, '/api/auto-find', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      minReputation: 5,
      minSpread: 1,
      minRoiPct: 0,
      minExpectedProfit: 5,
      minConservativeProfit: 0,
      minLiquidityOffers: 1,
      maxAgeHours: 0,
      maxResults: 3,
    }),
  });

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.result.map((route) => route.item.slug), [
    'arcane_energize',
    'blind_rage',
  ]);
  assert.deepEqual(body.errors, [{
    item: 'adaptation',
    error: 'Warframe Market returned invalid JSON.',
    code: 'MARKET_API_INVALID_JSON',
    attempts: 1,
  }]);
  assert.deepEqual(sleeps, [0]);

  const saved = await requestJson(baseUrl, `/api/snapshots/${body.snapshotId}`);
  assert.equal(saved.body.errors[0].code, 'MARKET_API_INVALID_JSON');
  const health = await requestJson(baseUrl, '/healthz');
  assert.equal(health.body.requests, 6);
  assert.equal(health.body.retries, 1);
  assert.equal(health.body.failures, 1);
});

test('analyze retries item timeouts, returns attempt metadata, and preserves successful routes', async (t) => {
  const { baseUrl } = await startFixtureApp(t, {
    routes: {
      '/orders/item/adaptation': { abort: true },
    },
    marketApiOptions: {
      maxAttempts: 2,
      timeoutMs: 10,
      sleepImpl: async () => {},
    },
  });
  const { response, body } = await requestJson(baseUrl, '/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: ['arcane energize', 'adaptation'],
      minSpread: 1,
      minRoiPct: 0,
      minExpectedProfit: 1,
      minConservativeProfit: 0,
      minLiquidityOffers: 1,
      maxAgeHours: 0,
    }),
  });

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.result.map((route) => route.item.slug), ['arcane_energize']);
  assert.deepEqual(body.errors, [{
    item: 'adaptation',
    error: 'Warframe Market request timed out after 10ms.',
    code: 'MARKET_API_TIMEOUT',
    attempts: 2,
  }]);
  assert.ok(body.snapshotId);

  const health = await requestJson(baseUrl, '/healthz');
  assert.equal(health.body.requests, 4);
  assert.equal(health.body.retries, 1);
  assert.equal(health.body.failures, 1);
});
