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

function fixtureResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function createFixtureFetch(requests, overrides = {}) {
  const fixtures = new Map([
    ['/items', 'items.json'],
    ['/orders/recent', overrides.recentOrders || 'recent-orders.json'],
    ['/orders/item/arcane_energize', 'arcane-energize-orders.json'],
    ['/orders/item/blind_rage', 'blind-rage-orders.json'],
    ['/orders/item/adaptation', 'invalid-collection.json'],
  ]);

  return async (url, options) => {
    const pathname = new URL(url).pathname.replace('/v2', '');
    requests.push({ pathname, headers: options.headers });
    const fixtureName = fixtures.get(pathname);
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
  });
  const snapshotStore = createSnapshotStore({
    snapshotFile: path.join(root, 'session-snapshots.json'),
  });
  const app = createApp({
    marketApi,
    snapshotStore,
    now: () => new Date('2026-09-06T22:00:00.000Z'),
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
  assert.match(failed.body.error, /fixture_maintenance/);

  const snapshots = await requestJson(baseUrl, '/api/snapshots');
  assert.deepEqual(snapshots.body.snapshots, []);
});
