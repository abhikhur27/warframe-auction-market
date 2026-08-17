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
  attachSnapshotContext,
  buildRouteFingerprint,
  normalizeMarketContext,
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
  assert.equal(list[0].marketContext.label, 'PC | Crossplay | EN');

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

test('route fingerprints use structured variant identity instead of display labels', () => {
  const original = {
    item: { slug: 'arcane-energize', name: 'Arcane Energize' },
    variant: { rank: 5, subtype: 'maxed', label: 'Rank 5 / Maxed' },
  };
  const relabeled = {
    item: { slug: 'arcane-energize', name: 'Arcane Energize' },
    variant: { rank: 5, subtype: 'MAXED', label: 'Fully ranked' },
  };

  assert.equal(
    buildRouteFingerprint(original, { platform: 'PC', language: 'EN', crossplay: true }),
    buildRouteFingerprint(relabeled, { platform: 'pc', language: 'en', crossplay: 'true' })
  );
  assert.notEqual(
    buildRouteFingerprint(original, { platform: 'pc', crossplay: true }),
    buildRouteFingerprint(original, { platform: 'xbox', crossplay: true })
  );
});

test('compareSnapshots refuses to blend different market contexts', () => {
  const route = {
    item: { slug: 'arcane-energize', name: 'Arcane Energize' },
    variant: { rank: 5, subtype: null, label: 'Rank 5' },
    expectedProfit: 40,
    roiPct: 18,
    executionScore: 70,
    bestSell: { price: 80 },
    buyerOptions: [{ price: 95 }],
  };
  const comparison = compareSnapshots(
    { options: { platform: 'pc', language: 'en', crossplay: true }, result: [route] },
    { options: { platform: 'xbox', language: 'en', crossplay: true }, result: [route] }
  );

  assert.equal(comparison.compatible, false);
  assert.equal(comparison.overlapCount, 0);
  assert.match(comparison.message, /different markets/);
});

test('compareSnapshots gives mixed routes one mutually exclusive classification', () => {
  const baseRoute = {
    item: { slug: 'arcane-energize', name: 'Arcane Energize' },
    variant: { label: 'Default' },
    expectedProfit: 40,
    roiPct: 18,
    executionScore: 75,
    bestSell: { price: 80 },
    buyerOptions: [{ price: 95 }],
  };
  const targetRoute = {
    ...baseRoute,
    expectedProfit: 50,
    roiPct: 21,
    executionScore: 62,
  };
  const comparison = compareSnapshots({ result: [baseRoute] }, { result: [targetRoute] });

  assert.equal(comparison.compatible, true);
  assert.equal(comparison.mixedCount, 1);
  assert.equal(comparison.improvedCount, 0);
  assert.equal(comparison.decayedCount, 0);
  assert.equal(comparison.unchangedCount, 0);
  assert.equal(comparison.mixedRoutes[0].change, 'mixed');
});

test('attachSnapshotContext annotates routes with improving and new momentum', () => {
  createSnapshot('analyze', {
    analyzedAt: '2026-08-01T12:00:00.000Z',
    result: [
      {
        item: { slug: 'arcane-energize', name: 'Arcane Energize' },
        variant: { label: 'Default' },
        expectedProfit: 32,
        roiPct: 17.5,
        executionScore: 63,
        bestSell: { price: 81 },
        buyerOptions: [{ price: 93 }],
      },
    ],
  });

  createSnapshot('analyze', {
    analyzedAt: '2026-08-03T12:00:00.000Z',
    result: [
      {
        item: { slug: 'arcane-energize', name: 'Arcane Energize' },
        variant: { label: 'Default' },
        expectedProfit: 40,
        roiPct: 19.2,
        executionScore: 69,
        bestSell: { price: 80 },
        buyerOptions: [{ price: 95 }],
      },
    ],
  });

  const annotated = attachSnapshotContext([
    {
      item: { slug: 'arcane-energize', name: 'Arcane Energize' },
      variant: { label: 'Default' },
      expectedProfit: 51,
      roiPct: 21.5,
      executionScore: 77,
      bestSell: { price: 79 },
      buyerOptions: [{ price: 97 }],
    },
    {
      item: { slug: 'blind-rage', name: 'Blind Rage' },
      variant: { label: 'Default' },
      expectedProfit: 24,
      roiPct: 12.5,
      executionScore: 58,
      bestSell: { price: 41 },
      buyerOptions: [{ price: 47 }],
    },
  ], [getSnapshotById(listSnapshotSummaries(2)[0].id), getSnapshotById(listSnapshotSummaries(2)[1].id)]);

  assert.equal(annotated[0].momentum.label, 'Improving route');
  assert.equal(annotated[0].momentum.tone, 'improving');
  assert.equal(annotated[0].momentum.seenCount, 2);
  assert.equal(annotated[0].momentum.latestProfitDelta, 11);
  assert.equal(annotated[1].momentum.label, 'New route');
  assert.equal(annotated[1].momentum.tone, 'new');
  assert.equal(annotated[1].momentum.seenCount, 0);
});

test('attachSnapshotContext only uses history from the current market', () => {
  const route = {
    item: { slug: 'arcane-energize', name: 'Arcane Energize' },
    variant: { rank: 5, subtype: null, label: 'Rank 5' },
    expectedProfit: 51,
    roiPct: 21.5,
    executionScore: 77,
    bestSell: { price: 79 },
    buyerOptions: [{ price: 97 }],
  };
  const xboxHistory = {
    analyzedAt: '2026-08-10T12:00:00.000Z',
    options: { platform: 'xbox', language: 'en', crossplay: true },
    result: [{ ...route, expectedProfit: 30 }],
  };
  const annotated = attachSnapshotContext(
    [route],
    [xboxHistory],
    { platform: 'pc', language: 'en', crossplay: true }
  );

  assert.equal(annotated[0].momentum.label, 'New route');
  assert.equal(annotated[0].momentum.seenCount, 0);
  assert.match(annotated[0].routeFingerprint, /^route-v2::pc::en::crossplay::/);
  assert.equal(normalizeMarketContext({ platform: 'XBOX', crossplay: false }).label, 'Xbox | Platform only | EN');
});
