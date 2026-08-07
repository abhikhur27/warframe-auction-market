const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  parseAnalysisOptions,
  analyzeSingleItem,
  getRecentCandidateItems,
  buildStressTest,
} = require('../server');
const {
  SNAPSHOT_FILE,
  createSnapshot,
  listSnapshotSummaries,
  getSnapshotById,
  compareSnapshots,
} = require('../snapshot-store');

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

test.beforeEach(() => {
  fs.rmSync(path.dirname(SNAPSHOT_FILE), { recursive: true, force: true });
});

test('parseAnalysisOptions clamps and normalizes incoming values', () => {
  const options = parseAnalysisOptions({
    platform: 'PS4',
    crossplay: 'false',
    statuses: ['InGame', 'ONLINE'],
    minExpectedProfit: '-8',
    minConservativeProfit: '-4',
    minLiquidityOffers: '99',
    buyerOptionCount: '0',
    sellerOptionCount: '-2',
  });

  assert.equal(options.platform, 'ps4');
  assert.equal(options.crossplay, false);
  assert.deepEqual(options.statuses, ['ingame', 'online']);
  assert.equal(options.minExpectedProfit, 0);
  assert.equal(options.minConservativeProfit, 0);
  assert.equal(options.minLiquidityOffers, 12);
  assert.equal(options.buyerOptionCount, 1);
  assert.equal(options.sellerOptionCount, 0);
});

test('analyzeSingleItem returns the best viable route and filters stale or weak offers', () => {
  const item = { slug: 'arcane-energize', name: 'Arcane Energize' };
  const options = {
    statuses: ['ingame', 'online'],
    minReputation: 5,
    minSpread: 8,
    minRoiPct: 10,
    minExpectedProfit: 16,
    minLiquidityOffers: 2,
    buyerOptionCount: 3,
    sellerOptionCount: 2,
    maxAgeHours: 24,
  };

  const orders = [
    { visible: true, type: 'sell', platinum: 80, quantity: 2, perTrade: 1, updatedAt: isoHoursAgo(1), user: { reputation: 10, status: 'ingame', ingameName: 'SellerA' } },
    { visible: true, type: 'sell', platinum: 82, quantity: 5, perTrade: 1, updatedAt: isoHoursAgo(2), user: { reputation: 7, status: 'online', ingameName: 'SellerB' } },
    { visible: true, type: 'buy', platinum: 95, quantity: 2, perTrade: 1, updatedAt: isoHoursAgo(1), user: { reputation: 11, status: 'ingame', ingameName: 'BuyerA' } },
    { visible: true, type: 'buy', platinum: 94, quantity: 2, perTrade: 1, updatedAt: isoHoursAgo(4), user: { reputation: 8, status: 'online', ingameName: 'BuyerB' } },
    { visible: true, type: 'buy', platinum: 93, quantity: 2, perTrade: 1, updatedAt: isoHoursAgo(4), user: { reputation: 8, status: 'online', ingameName: 'BuyerC' } },
    { visible: true, type: 'buy', platinum: 92, quantity: 2, perTrade: 1, updatedAt: isoHoursAgo(5), user: { reputation: 8, status: 'online', ingameName: 'BuyerD' } },
    { visible: true, type: 'buy', platinum: 91, quantity: 2, perTrade: 1, updatedAt: isoHoursAgo(5), user: { reputation: 8, status: 'online', ingameName: 'BuyerE' } },
    { visible: true, type: 'buy', platinum: 500, quantity: 1, perTrade: 1, updatedAt: isoHoursAgo(2), user: { reputation: 15, status: 'ingame', ingameName: 'OutlierBuyer' } },
    { visible: true, type: 'sell', platinum: 79, quantity: 1, perTrade: 1, updatedAt: isoHoursAgo(30), user: { reputation: 12, status: 'ingame', ingameName: 'StaleSeller' } },
  ];

  const analyzed = analyzeSingleItem(item, orders, options);
  assert.ok(analyzed);
  assert.equal(analyzed.bestSell.price, 80);
  assert.equal(analyzed.buyerOptions[0].price, 95);
  assert.equal(analyzed.spread, 15);
  assert.equal(analyzed.expectedProfit, 30);
  assert.equal(analyzed.stressTest.conservativeExpectedProfit, 24);
  assert.equal(analyzed.stressTest.profitRetentionPct, 80);
  assert.equal(analyzed.stressTest.backupRouteReady, true);
  assert.equal(analyzed.buyerOptions.some((entry) => entry.price === 500), false);
  assert.match(analyzed.bestSell.whisper, /Arcane Energize/);
});

test('analyzeSingleItem can require fallback profit instead of top-of-book profit only', () => {
  const item = { slug: 'arcane-energize', name: 'Arcane Energize' };
  const orders = [
    { visible: true, type: 'sell', platinum: 80, quantity: 2, perTrade: 1, updatedAt: isoHoursAgo(1), user: { reputation: 10, status: 'ingame', ingameName: 'SellerA' } },
    { visible: true, type: 'sell', platinum: 85, quantity: 2, perTrade: 1, updatedAt: isoHoursAgo(1), user: { reputation: 10, status: 'ingame', ingameName: 'SellerB' } },
    { visible: true, type: 'buy', platinum: 95, quantity: 2, perTrade: 1, updatedAt: isoHoursAgo(1), user: { reputation: 10, status: 'ingame', ingameName: 'BuyerA' } },
    { visible: true, type: 'buy', platinum: 90, quantity: 2, perTrade: 1, updatedAt: isoHoursAgo(1), user: { reputation: 10, status: 'ingame', ingameName: 'BuyerB' } },
  ];

  const strictResult = analyzeSingleItem(item, orders, {
    statuses: ['ingame'],
    minReputation: 0,
    minSpread: 5,
    minRoiPct: 0,
    minExpectedProfit: 10,
    minConservativeProfit: 12,
    minLiquidityOffers: 1,
    buyerOptionCount: 3,
    sellerOptionCount: 2,
    maxAgeHours: 24,
  });

  assert.equal(strictResult, null);
});

test('buildStressTest explains when no backup route exists', () => {
  const bestSell = { platinum: 80, quantity: 2, updatedAt: isoHoursAgo(1), user: { ingameName: 'SellerA' } };
  const onlyBuyer = [{
    order: { platinum: 95, quantity: 2, updatedAt: isoHoursAgo(1), user: { ingameName: 'BuyerA' } },
    quantity: 2,
  }];
  const result = buildStressTest(bestSell, [bestSell], onlyBuyer);

  assert.equal(result.backupRouteReady, false);
  assert.equal(result.conservativeExpectedProfit, 0);
  assert.match(result.summary, /No second-route fallback|No backup/);
});

test('getRecentCandidateItems ranks active two-sided items ahead of thin candidates', () => {
  const options = {
    statuses: ['ingame'],
    minReputation: 3,
    maxAgeHours: 24,
  };

  const candidateMap = new Map([
    [1, { id: 1, slug: 'arcane-energize', name: 'Arcane Energize' }],
    [2, { id: 2, slug: 'adaptation', name: 'Adaptation' }],
  ]);

  const recentOrders = [
    { itemId: 1, visible: true, type: 'sell', platinum: 80, updatedAt: isoHoursAgo(1), user: { reputation: 4, status: 'ingame' } },
    { itemId: 1, visible: true, type: 'buy', platinum: 95, updatedAt: isoHoursAgo(1), user: { reputation: 6, status: 'ingame' } },
    { itemId: 2, visible: true, type: 'sell', platinum: 10, updatedAt: isoHoursAgo(1), user: { reputation: 5, status: 'ingame' } },
  ];

  const result = getRecentCandidateItems(recentOrders, options, candidateMap);
  assert.equal(result[0].item.slug, 'arcane-energize');
  assert.equal(result[0].activeTwoSided, true);
});

test('snapshot store persists summaries and full records', () => {
  const snapshot = createSnapshot('analyze', {
    analyzedAt: '2026-07-29T12:00:00.000Z',
    options: { platform: 'pc' },
    requestedCount: 3,
    resolvedCount: 2,
    result: [{
      item: { name: 'Arcane Energize' },
      variant: { label: 'Default' },
      expectedProfit: 40,
      roiPct: 18.2,
    }],
  });

  const list = listSnapshotSummaries(5);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, snapshot.id);
  assert.equal(list[0].topRoute.itemName, 'Arcane Energize');

  const loaded = getSnapshotById(snapshot.id);
  assert.equal(loaded.id, snapshot.id);
  assert.equal(loaded.result[0].expectedProfit, 40);
});

test('compareSnapshots surfaces improved, decayed, new, and dropped routes', () => {
  const baseSnapshot = createSnapshot('analyze', {
    analyzedAt: '2026-08-01T12:00:00.000Z',
    result: [
      {
        item: { slug: 'arcane-energize', name: 'Arcane Energize' },
        variant: { label: 'Default' },
        expectedProfit: 40,
        roiPct: 18.2,
        executionScore: 70,
        bestSell: { price: 80 },
        buyerOptions: [{ price: 95 }],
      },
      {
        item: { slug: 'adaptation', name: 'Adaptation' },
        variant: { label: 'Default' },
        expectedProfit: 25,
        roiPct: 14,
        executionScore: 61,
        bestSell: { price: 20 },
        buyerOptions: [{ price: 30 }],
      },
    ],
  });

  const targetSnapshot = createSnapshot('analyze', {
    analyzedAt: '2026-08-04T12:00:00.000Z',
    result: [
      {
        item: { slug: 'arcane-energize', name: 'Arcane Energize' },
        variant: { label: 'Default' },
        expectedProfit: 52,
        roiPct: 21.5,
        executionScore: 76,
        bestSell: { price: 79 },
        buyerOptions: [{ price: 97 }],
      },
      {
        item: { slug: 'blind-rage', name: 'Blind Rage' },
        variant: { label: 'Default' },
        expectedProfit: 31,
        roiPct: 16.5,
        executionScore: 58,
        bestSell: { price: 40 },
        buyerOptions: [{ price: 48 }],
      },
    ],
  });

  const comparison = compareSnapshots(baseSnapshot, targetSnapshot);
  assert.equal(comparison.overlapCount, 1);
  assert.equal(comparison.improvedCount, 1);
  assert.equal(comparison.decayedCount, 0);
  assert.equal(comparison.newCount, 1);
  assert.equal(comparison.droppedCount, 1);
  assert.equal(comparison.topImproved[0].itemName, 'Arcane Energize');
  assert.equal(comparison.topImproved[0].profitDelta, 12);
  assert.equal(comparison.newRoutes[0].itemName, 'Blind Rage');
  assert.equal(comparison.droppedRoutes[0].itemName, 'Adaptation');
});
