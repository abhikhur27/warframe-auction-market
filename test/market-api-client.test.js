const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createMarketApiClient } = require('../market-api-client');
const {
  parseAnalysisOptions,
  analyzeSingleItem,
  getRecentCandidateItems,
  normalizeItem,
} = require('../server');

const fixtureDir = path.join(__dirname, 'fixtures', 'market-v2');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function response(body, status = 200, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalizedHeaders.get(name.toLowerCase()) || null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function createFixtureFetch(requests) {
  const fixtureByPath = new Map([
    ['/items', readFixture('items.json')],
    ['/orders/recent', readFixture('recent-orders.json')],
    ['/orders/item/arcane_energize', readFixture('arcane-energize-orders.json')],
  ]);

  return async (url, options) => {
    const pathname = new URL(url).pathname.replace('/v2', '');
    requests.push({ pathname, headers: options.headers });
    const fixture = fixtureByPath.get(pathname);
    if (!fixture) return response({ error: 'Fixture not found' }, 404);
    return response(fixture);
  };
}

test('replays the external v2 item, recent-order, and item-order contract offline', async () => {
  const requests = [];
  const client = createMarketApiClient({
    fetchImpl: createFixtureFetch(requests),
    requestDelayMs: 0,
    maxAttempts: 1,
  });

  const items = (await client.get('/items')).map(normalizeItem);
  const itemLookup = new Map(items.map((item) => [item.id, item]));
  const recentOrders = await client.get('/orders/recent', {
    platform: 'pc',
    language: 'en',
    crossplay: true,
  });
  const options = parseAnalysisOptions({
    statuses: ['ingame', 'online'],
    minReputation: 5,
    minSpread: 8,
    minRoiPct: 10,
    minExpectedProfit: 20,
    minConservativeProfit: 20,
    minLiquidityOffers: 2,
    buyerOptionCount: 3,
    sellerOptionCount: 2,
    maxAgeHours: 0,
  });
  const candidates = getRecentCandidateItems(recentOrders, options, itemLookup);

  assert.equal(items[0].name, 'Arcane Energize');
  assert.equal(candidates[0].item.slug, 'arcane_energize');
  assert.equal(candidates[0].spreadHint, 15);
  assert.equal(candidates[0].activeTwoSided, true);

  const orders = await client.get('/orders/item/arcane_energize', options);
  const analyzed = analyzeSingleItem(candidates[0].item, orders, options);

  assert.equal(analyzed.variant.rank, 5);
  assert.equal(analyzed.bestSell.price, 80);
  assert.equal(analyzed.buyerOptions[0].price, 95);
  assert.equal(analyzed.expectedProfit, 30);
  assert.equal(analyzed.stressTest.conservativeExpectedProfit, 24);
  assert.equal(analyzed.liquidity.sellOffers, 2);
  assert.equal(analyzed.liquidity.buyOffers, 3);
  assert.deepEqual(requests[1], {
    pathname: '/orders/recent',
    headers: { platform: 'pc', language: 'en', crossplay: 'true' },
  });
});

test('retries rate-limited requests and exposes retry telemetry', async () => {
  const sleeps = [];
  let attempts = 0;
  const client = createMarketApiClient({
    requestDelayMs: 0,
    maxAttempts: 2,
    sleepImpl: async (ms) => sleeps.push(ms),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return response({ error: 'slow down' }, 429, { 'retry-after': '0' });
      }
      return response(readFixture('items.json'));
    },
  });

  const data = await client.get('/items');
  const telemetry = client.getTelemetry();

  assert.equal(data.length, 3);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [0]);
  assert.equal(telemetry.requests, 2);
  assert.equal(telemetry.retries, 1);
  assert.equal(telemetry.failures, 0);
});

test('rejects a successful response when the upstream data envelope drifts', async () => {
  const client = createMarketApiClient({
    requestDelayMs: 0,
    maxAttempts: 1,
    fetchImpl: async () => response(readFixture('invalid-envelope.json')),
  });

  await assert.rejects(
    client.get('/items'),
    (error) => error.code === 'MARKET_API_INVALID_ENVELOPE'
  );
  assert.equal(client.getTelemetry().failures, 1);
});

test('rejects collection endpoints whose data payload is not an array', async () => {
  const client = createMarketApiClient({
    requestDelayMs: 0,
    maxAttempts: 1,
    fetchImpl: async () => response(readFixture('invalid-collection.json')),
  });

  await assert.rejects(
    client.getCollection('/orders/recent'),
    (error) => error.code === 'MARKET_API_INVALID_DATA'
  );
  assert.equal(client.getTelemetry().failures, 1);
});

test('preserves structured upstream errors as bounded response failures', async () => {
  const client = createMarketApiClient({
    requestDelayMs: 0,
    maxAttempts: 1,
    fetchImpl: async () => response(readFixture('response-error.json')),
  });

  await assert.rejects(
    client.get('/orders/recent'),
    (error) => error.code === 'MARKET_API_RESPONSE_ERROR'
      && error.message.includes('fixture_maintenance')
  );
  assert.equal(client.getTelemetry().failures, 1);
});

test('enforces the configured concurrency ceiling', async () => {
  let active = 0;
  let peakActive = 0;
  const client = createMarketApiClient({
    requestDelayMs: 0,
    maxAttempts: 1,
    maxConcurrent: 2,
    fetchImpl: async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return response({ data: [] });
    },
  });

  await Promise.all(Array.from({ length: 6 }, () => client.get('/items')));

  assert.equal(peakActive, 2);
  assert.deepEqual(client.getTelemetry(), {
    activeRequests: 0,
    queueDepth: 0,
    requests: 6,
    retries: 0,
    failures: 0,
  });
});
