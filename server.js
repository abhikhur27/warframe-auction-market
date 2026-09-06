const express = require('express');
const path = require('path');
const {
  DEFAULT_PLATFORM,
  DEFAULT_LANGUAGE,
  createMarketApiClient,
} = require('./market-api-client');
const {
  compareSnapshots,
} = require('./snapshot-store');
const defaultSnapshotStore = require('./snapshot-store');

const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

function toBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function normalizeItem(raw) {
  const name = raw?.i18n?.en?.name || raw.slug;
  return {
    id: raw.id,
    slug: raw.slug,
    name,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    maxRank: Number.isInteger(raw.maxRank) ? raw.maxRank : null,
    subtypes: Array.isArray(raw.subtypes) ? raw.subtypes : [],
  };
}

async function ensureItemsLoaded(runtime, force = false) {
  const { marketApi, itemCache, nowMs } = runtime;
  const stale = nowMs() - itemCache.loadedAt > CACHE_TTL_MS;
  if (!force && itemCache.items.length > 0 && !stale) {
    return itemCache.items;
  }

  const rawItems = await marketApi.getCollection('/items');
  const items = rawItems.map(normalizeItem);
  items.sort((a, b) => a.name.localeCompare(b.name));

  const bySlug = new Map();
  const byName = new Map();
  const byId = new Map();

  for (const item of items) {
    bySlug.set(item.slug.toLowerCase(), item);
    byName.set(item.name.toLowerCase(), item);
    byId.set(item.id, item);
  }

  itemCache.items = items;
  itemCache.bySlug = bySlug;
  itemCache.byName = byName;
  itemCache.byId = byId;
  itemCache.loadedAt = nowMs();

  return items;
}

function searchItems(itemCache, query, limit = 12) {
  const normalizedQuery = (query || '').trim().toLowerCase();
  if (!normalizedQuery) return [];

  const exact = [];
  const startsWith = [];
  const contains = [];

  for (const item of itemCache.items) {
    const slug = item.slug.toLowerCase();
    const name = item.name.toLowerCase();

    if (slug === normalizedQuery || name === normalizedQuery) {
      exact.push(item);
      continue;
    }

    if (slug.startsWith(normalizedQuery) || name.startsWith(normalizedQuery)) {
      startsWith.push(item);
      continue;
    }

    if (slug.includes(normalizedQuery) || name.includes(normalizedQuery)) {
      contains.push(item);
    }
  }

  return [...exact, ...startsWith, ...contains].slice(0, limit);
}

function resolveItems(itemCache, identifiers) {
  const resolved = [];
  const unresolved = [];
  const seen = new Set();

  for (const raw of identifiers) {
    const term = String(raw || '').trim();
    if (!term) continue;

    const lower = term.toLowerCase();
    let match = itemCache.bySlug.get(lower) || itemCache.byName.get(lower);

    if (!match) {
      const fuzzy = searchItems(itemCache, term, 1);
      if (fuzzy.length === 1) {
        match = fuzzy[0];
      }
    }

    if (!match) {
      unresolved.push(term);
      continue;
    }

    if (seen.has(match.slug)) continue;
    seen.add(match.slug);
    resolved.push(match);
  }

  return { resolved, unresolved };
}

function isStatusAllowed(order, statusSet) {
  const status = order?.user?.status || 'offline';
  return statusSet.has(status);
}

function isFreshEnough(order, maxAgeHours) {
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return true;
  if (!order.updatedAt) return true;

  const updatedAt = Date.parse(order.updatedAt);
  if (Number.isNaN(updatedAt)) return true;

  const ageMs = Date.now() - updatedAt;
  return ageMs <= maxAgeHours * 60 * 60 * 1000;
}

function formatVariantKey(order) {
  const rank = Number.isInteger(order.rank) ? order.rank : null;
  const subtype = order.subtype || null;
  return `${rank === null ? 'na' : rank}|${subtype || 'na'}`;
}

function formatVariantLabel(rank, subtype) {
  const parts = [];
  if (rank !== null && rank !== undefined) parts.push(`Rank ${rank}`);
  if (subtype) parts.push(`Subtype ${subtype}`);
  if (parts.length === 0) return 'Default';
  return parts.join(' | ');
}

function keepBestOffers(orders, direction = 'asc') {
  const sorted = [...orders].sort((a, b) => {
    if (a.platinum !== b.platinum) {
      return direction === 'asc' ? a.platinum - b.platinum : b.platinum - a.platinum;
    }

    const repA = a.user?.reputation || 0;
    const repB = b.user?.reputation || 0;
    if (repA !== repB) return repB - repA;

    const timeA = Date.parse(a.updatedAt || '') || 0;
    const timeB = Date.parse(b.updatedAt || '') || 0;
    return timeB - timeA;
  });

  return sorted;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function getHighOutlierFence(values) {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = Math.max(0, (q3 ?? 0) - (q1 ?? 0));
  if (iqr === 0) {
    return (q3 ?? values[0]) * 1.75 + 20;
  }
  return (q3 ?? values[0]) + 3 * iqr;
}

function ageHours(updatedAt) {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, (Date.now() - parsed) / (1000 * 60 * 60));
}

function scoreExecutionConfidence(bestSell, topBuyer, sellCount, buyCount, sellerOptionCount, buyerOptionCount) {
  const sellAge = ageHours(bestSell?.updatedAt);
  const buyAge = ageHours(topBuyer?.order?.updatedAt);
  const freshestAge = Math.max(0, Math.min(sellAge ?? 48, buyAge ?? 48));
  const freshnessScore = Math.max(0, 40 - freshestAge * 3.5);
  const liquidityScore = Math.min(35, (Math.min(sellCount, 6) * 3) + (Math.min(buyCount, 6) * 3));
  const backupScore = Math.min(15, sellerOptionCount * 3 + buyerOptionCount * 2);
  const quantityScore = Math.min(10, Math.max(bestSell?.quantity || 0, topBuyer?.quantity || 0));
  return Math.round(freshnessScore + liquidityScore + backupScore + quantityScore);
}

function buildStressTest(bestSell, sells, candidateBuys) {
  const backupSeller = sells[1] || null;
  const backupBuyer = candidateBuys[1] || null;

  if (!backupSeller || !backupBuyer) {
    return {
      backupRouteReady: false,
      conservativeSpread: 0,
      conservativeRoiPct: 0,
      conservativeExpectedProfit: 0,
      conservativeQuantity: 0,
      profitRetentionPct: 0,
      backupSeller: backupSeller ? {
        price: backupSeller.platinum,
        quantity: backupSeller.quantity,
        updatedAt: backupSeller.updatedAt,
        seller: backupSeller.user,
      } : null,
      backupBuyer: backupBuyer ? {
        price: backupBuyer.order.platinum,
        quantity: backupBuyer.order.quantity,
        updatedAt: backupBuyer.order.updatedAt,
        buyer: backupBuyer.order.user,
      } : null,
      summary: !backupSeller && !backupBuyer
        ? 'No second-route fallback yet. The spread only works off the first visible quote on both sides.'
        : !backupSeller
          ? 'No backup seller matched the filter, so the buy-in anchor could disappear.'
          : 'No backup buyer matched the filter, so one failed whisper can collapse the route.',
    };
  }

  const conservativeSpread = backupBuyer.order.platinum - backupSeller.platinum;
  const conservativeQuantity = Math.max(
    1,
    Math.min(backupBuyer.quantity || 1, backupSeller.quantity || 1)
  );
  const conservativeExpectedProfit = conservativeSpread * conservativeQuantity;
  const conservativeRoiPct = backupSeller.platinum > 0
    ? (conservativeSpread / backupSeller.platinum) * 100
    : 0;

  return {
    backupRouteReady: true,
    conservativeSpread,
    conservativeRoiPct: Number(conservativeRoiPct.toFixed(1)),
    conservativeExpectedProfit,
    conservativeQuantity,
    backupSeller: {
      price: backupSeller.platinum,
      quantity: backupSeller.quantity,
      updatedAt: backupSeller.updatedAt,
      seller: backupSeller.user,
    },
    backupBuyer: {
      price: backupBuyer.order.platinum,
      quantity: backupBuyer.order.quantity,
      updatedAt: backupBuyer.order.updatedAt,
      buyer: backupBuyer.order.user,
    },
    summary: `Second-best route still clears ${conservativeExpectedProfit}p across ${conservativeQuantity} item(s) if the top quote disappears.`,
  };
}

function makeWhisper(order, itemName, variantLabel, actionWord) {
  const target = order?.user?.ingameName || 'unknown';
  const amount = order?.platinum;
  const flavor = variantLabel && variantLabel !== 'Default' ? ` (${variantLabel})` : '';
  return `/w ${target} Hi! ${actionWord} ${itemName}${flavor} for ${amount}p.`;
}

function analyzeSingleItem(item, orders, options) {
  const statusSet = new Set(options.statuses);
  const minReputation = options.minReputation;
  const minSpread = options.minSpread;
  const minRoiPct = options.minRoiPct;
  const minExpectedProfit = options.minExpectedProfit;
  const minConservativeProfit = options.minConservativeProfit;
  const minLiquidityOffers = options.minLiquidityOffers;
  const buyerOptionCount = options.buyerOptionCount;
  const sellerOptionCount = options.sellerOptionCount;
  const maxAgeHours = options.maxAgeHours;

  const grouped = new Map();

  for (const order of orders) {
    if (!order || !order.visible) continue;
    if (!isStatusAllowed(order, statusSet)) continue;
    if (!isFreshEnough(order, maxAgeHours)) continue;

    const reputation = order.user?.reputation || 0;
    if (reputation < minReputation) continue;

    const key = formatVariantKey(order);
    if (!grouped.has(key)) {
      grouped.set(key, {
        rank: Number.isInteger(order.rank) ? order.rank : null,
        subtype: order.subtype || null,
        sells: [],
        buys: [],
      });
    }

    if (order.type === 'sell') grouped.get(key).sells.push(order);
    if (order.type === 'buy') grouped.get(key).buys.push(order);
  }

  let best = null;

  for (const group of grouped.values()) {
    const sells = keepBestOffers(group.sells, 'asc');
    const buys = keepBestOffers(group.buys, 'desc');

    if (sells.length === 0 || buys.length === 0) continue;
    if (sells.length < minLiquidityOffers || buys.length < minLiquidityOffers) continue;

    const buyPrices = buys.map((x) => x.platinum).filter((x) => Number.isFinite(x));
    const highOutlierFence = getHighOutlierFence(buyPrices);

    const bestSell = sells[0];
    const candidateBuys = buys
      .filter((buy) => buy.platinum <= highOutlierFence)
      .map((buy) => {
        const spread = buy.platinum - bestSell.platinum;
        const roiPct = bestSell.platinum > 0 ? (spread / bestSell.platinum) * 100 : 0;
        const quantity = Math.min(buy.quantity || 1, bestSell.quantity || 1);
        return {
          order: buy,
          spread,
          roiPct,
          quantity,
          expectedProfit: spread * Math.max(quantity, 1),
        };
      })
      .filter(
        (entry) =>
          entry.spread >= minSpread &&
          entry.roiPct >= minRoiPct &&
          entry.expectedProfit >= minExpectedProfit
      )
      .slice(0, buyerOptionCount);

    if (candidateBuys.length === 0) continue;

    const top = candidateBuys[0];
    const variantLabel = formatVariantLabel(group.rank, group.subtype);
    const executionScore = scoreExecutionConfidence(
      bestSell,
      top,
      sells.length,
      buys.length,
      Math.max(Math.min(sells.length - 1, sellerOptionCount), 0),
      candidateBuys.length
    );
    const stressTest = buildStressTest(bestSell, sells, candidateBuys);
    const profitRetentionPct = top.expectedProfit > 0
      ? Number(((stressTest.conservativeExpectedProfit / top.expectedProfit) * 100).toFixed(1))
      : 0;

    if (stressTest.conservativeExpectedProfit < minConservativeProfit) {
      continue;
    }

    const offer = {
      item: {
        slug: item.slug,
        name: item.name,
      },
      variant: {
        rank: group.rank,
        subtype: group.subtype,
        label: variantLabel,
      },
      spread: top.spread,
      roiPct: Number(top.roiPct.toFixed(1)),
      expectedProfit: top.expectedProfit,
      executionScore,
      recommendedQuantity: top.quantity,
      stressTest: {
        ...stressTest,
        profitRetentionPct,
      },
      bestSell: {
        price: bestSell.platinum,
        quantity: bestSell.quantity,
        perTrade: bestSell.perTrade,
        updatedAt: bestSell.updatedAt,
        seller: bestSell.user,
        whisper: makeWhisper(bestSell, item.name, variantLabel, 'wtb'),
      },
      buyerOptions: candidateBuys.map((entry) => ({
        price: entry.order.platinum,
        quantity: entry.order.quantity,
        perTrade: entry.order.perTrade,
        spread: entry.spread,
        roiPct: Number(entry.roiPct.toFixed(1)),
        expectedProfit: entry.expectedProfit,
        updatedAt: entry.order.updatedAt,
        buyer: entry.order.user,
        whisper: makeWhisper(entry.order, item.name, variantLabel, 'wts'),
      })),
      sellerAlternatives: sells.slice(1, 1 + sellerOptionCount).map((sell) => ({
        price: sell.platinum,
        quantity: sell.quantity,
        perTrade: sell.perTrade,
        updatedAt: sell.updatedAt,
        seller: sell.user,
        whisper: makeWhisper(sell, item.name, variantLabel, 'wtb'),
      })),
      liquidity: {
        buyOffers: buys.length,
        sellOffers: sells.length,
      },
    };

    if (!best || offer.expectedProfit > best.expectedProfit) {
      best = offer;
    }
  }

  return best;
}

function parseAnalysisOptions(body = {}) {
  return {
    platform: String(body.platform || DEFAULT_PLATFORM).toLowerCase(),
    language: String(body.language || DEFAULT_LANGUAGE).toLowerCase(),
    crossplay: toBoolean(body.crossplay, true),
    statuses: Array.isArray(body.statuses) && body.statuses.length > 0
      ? body.statuses.map((x) => String(x).toLowerCase())
      : ['ingame', 'online'],
    minReputation: Number.isFinite(Number(body.minReputation)) ? Number(body.minReputation) : 0,
    minSpread: Number.isFinite(Number(body.minSpread)) ? Number(body.minSpread) : 6,
    minRoiPct: Number.isFinite(Number(body.minRoiPct)) ? Number(body.minRoiPct) : 10,
    minExpectedProfit: Number.isFinite(Number(body.minExpectedProfit)) ? Math.max(Number(body.minExpectedProfit), 0) : 20,
    minConservativeProfit: Number.isFinite(Number(body.minConservativeProfit)) ? Math.max(Number(body.minConservativeProfit), 0) : 0,
    minLiquidityOffers: Number.isFinite(Number(body.minLiquidityOffers)) ? Math.min(Math.max(Number(body.minLiquidityOffers), 1), 12) : 1,
    buyerOptionCount: Number.isFinite(Number(body.buyerOptionCount)) ? Math.min(Math.max(Number(body.buyerOptionCount), 1), 8) : 4,
    sellerOptionCount: Number.isFinite(Number(body.sellerOptionCount)) ? Math.min(Math.max(Number(body.sellerOptionCount), 0), 8) : 3,
    maxAgeHours: Number.isFinite(Number(body.maxAgeHours)) ? Math.max(Number(body.maxAgeHours), 0) : 48,
  };
}

async function analyzeResolvedItems(marketApi, resolved, options) {
  const tasks = resolved.map(async (item) => {
    try {
      const orders = await marketApi.getCollection(`/orders/item/${encodeURIComponent(item.slug)}`, {
        platform: options.platform,
        language: options.language,
        crossplay: options.crossplay,
      });
      const analyzed = analyzeSingleItem(item, orders, options);
      return { analyzed, error: null };
    } catch (error) {
      return {
        analyzed: null,
        error: {
          item: item.slug,
          error: error.message || 'Unknown error',
          code: error.code || 'ITEM_ANALYSIS_FAILED',
        },
      };
    }
  });

  const settled = await Promise.all(tasks);
  const result = [];
  const errors = [];
  for (const entry of settled) {
    if (entry.analyzed) result.push(entry.analyzed);
    if (entry.error) errors.push(entry.error);
  }

  result.sort((a, b) => b.expectedProfit - a.expectedProfit);
  return { result, errors };
}

function enrichResultRowsWithSnapshotContext(snapshotStore, rows, options) {
  return snapshotStore.attachSnapshotContext(
    rows,
    snapshotStore.listSnapshotSummaries(8)
      .map((summary) => snapshotStore.getSnapshotById(summary.id)),
    options
  );
}

function getRecentCandidateItems(recentOrders, options, itemLookup = new Map()) {
  const statusSet = new Set(options.statuses);
  const minReputation = options.minReputation;
  const maxAgeHours = options.maxAgeHours;

  const statsByItem = new Map();

  for (const order of recentOrders) {
    if (!order || !order.itemId || !order.visible) continue;
    if (!isStatusAllowed(order, statusSet)) continue;
    if (!isFreshEnough(order, maxAgeHours)) continue;
    if ((order.user?.reputation || 0) < minReputation) continue;

    if (!statsByItem.has(order.itemId)) {
      statsByItem.set(order.itemId, {
        itemId: order.itemId,
        recentCount: 0,
        sellCount: 0,
        buyCount: 0,
        minSell: Number.POSITIVE_INFINITY,
        maxBuy: Number.NEGATIVE_INFINITY,
      });
    }

    const stat = statsByItem.get(order.itemId);
    stat.recentCount += 1;

    if (order.type === 'sell') {
      stat.sellCount += 1;
      stat.minSell = Math.min(stat.minSell, order.platinum);
    } else if (order.type === 'buy') {
      stat.buyCount += 1;
      stat.maxBuy = Math.max(stat.maxBuy, order.platinum);
    }
  }

  const prioritized = [];
  const fallback = [];

  for (const stat of statsByItem.values()) {
    const item = itemLookup.get(stat.itemId);
    if (!item) continue;

    const spreadHint = Number.isFinite(stat.maxBuy) && Number.isFinite(stat.minSell)
      ? stat.maxBuy - stat.minSell
      : Number.NEGATIVE_INFINITY;
    const activeTwoSided = stat.sellCount > 0 && stat.buyCount > 0;
    const candidate = {
      item,
      recentCount: stat.recentCount,
      sellCount: stat.sellCount,
      buyCount: stat.buyCount,
      spreadHint,
      activeTwoSided,
    };

    if (activeTwoSided) prioritized.push(candidate);
    else fallback.push(candidate);
  }

  prioritized.sort((a, b) => {
    if (a.spreadHint !== b.spreadHint) return b.spreadHint - a.spreadHint;
    return b.recentCount - a.recentCount;
  });

  fallback.sort((a, b) => b.recentCount - a.recentCount);

  return [...prioritized, ...fallback];
}

function createApp(dependencies = {}) {
  const marketApi = dependencies.marketApi || createMarketApiClient();
  const snapshotStore = {
    ...defaultSnapshotStore,
    ...(dependencies.snapshotStore || {}),
  };
  const now = dependencies.now || (() => new Date());
  const nowMs = () => now().getTime();
  const itemCache = {
    loadedAt: 0,
    items: [],
    bySlug: new Map(),
    byName: new Map(),
    byId: new Map(),
  };
  const runtime = { marketApi, itemCache, nowMs };
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(dependencies.publicDir || path.join(__dirname, 'public')));

  function sendServerError(res, error, fallback = 'Unknown server error') {
    const isUpstreamFailure = String(error?.code || '').startsWith('MARKET_API_');
    return res.status(isUpstreamFailure ? 502 : 500).json({
      error: error?.message || fallback,
      code: error?.code || 'SERVER_ERROR',
    });
  }

  app.get('/api/health', async (_req, res) => {
    res.json({ ok: true, now: now().toISOString() });
  });

  async function handleItemsLookup(req, res) {
    try {
      await ensureItemsLoaded(runtime);
      const q = String(req.query.q || '').trim();
      if (!q) {
        return res.json({ items: itemCache.items.slice(0, 20) });
      }

      const limit = Number(req.query.limit || 12);
      const items = searchItems(itemCache, q, Math.max(1, Math.min(limit, 30)));
      return res.json({ items });
    } catch (error) {
      return sendServerError(res, error, 'Failed to load items');
    }
  }

  app.get('/api/items', handleItemsLookup);
  app.get('/api/items/search', handleItemsLookup);

  app.post('/api/analyze', async (req, res) => {
    try {
      await ensureItemsLoaded(runtime);

      const body = req.body || {};
      const rawItems = Array.isArray(body.items) ? body.items : [];

      if (rawItems.length === 0) {
        return res.status(400).json({ error: 'Please provide at least one item name or slug.' });
      }

      const { resolved, unresolved } = resolveItems(itemCache, rawItems);
      if (resolved.length === 0) {
        return res.status(400).json({ error: 'No valid items were found.', unresolved });
      }

      const options = parseAnalysisOptions(body);
      const { result, errors } = await analyzeResolvedItems(marketApi, resolved, options);
      const enrichedResult = enrichResultRowsWithSnapshotContext(snapshotStore, result, options);
      const payload = {
        analyzedAt: now().toISOString(),
        options,
        requestedCount: rawItems.length,
        resolvedCount: resolved.length,
        unresolved,
        result: enrichedResult,
        errors,
      };
      const snapshot = snapshotStore.createSnapshot('analyze', payload);
      return res.json({
        ...payload,
        snapshotId: snapshot.id,
      });
    } catch (error) {
      return sendServerError(res, error);
    }
  });

  app.post('/api/auto-find', async (req, res) => {
    try {
      await ensureItemsLoaded(runtime);

      const body = req.body || {};
      const options = parseAnalysisOptions(body);
      const maxResults = Number.isFinite(Number(body.maxResults))
        ? Math.min(Math.max(Number(body.maxResults), 1), 100)
        : 25;

      const recentOrders = await marketApi.getCollection('/orders/recent', {
        platform: options.platform,
        language: options.language,
        crossplay: options.crossplay,
      });

      const candidates = getRecentCandidateItems(recentOrders, options, itemCache.byId);
      const analysisBudget = Math.min(candidates.length, Math.max(maxResults * 3, 30));
      const selected = candidates.slice(0, analysisBudget).map((x) => x.item);
      const { result, errors } = await analyzeResolvedItems(marketApi, selected, options);
      const enrichedResult = enrichResultRowsWithSnapshotContext(snapshotStore, result, options);
      const payload = {
        analyzedAt: now().toISOString(),
        options,
        scannedCount: selected.length,
        candidateCount: candidates.length,
        analysisBudget,
        result: enrichedResult.slice(0, maxResults),
        errors,
      };
      const snapshot = snapshotStore.createSnapshot('auto-find', payload);
      return res.json({
        ...payload,
        snapshotId: snapshot.id,
      });
    } catch (error) {
      return sendServerError(res, error);
    }
  });

  app.get('/api/snapshots', (req, res) => {
    const limit = Number(req.query.limit || 12);
    return res.json({ snapshots: snapshotStore.listSnapshotSummaries(limit) });
  });

  app.get('/api/snapshots/compare/:baseId/:targetId', (req, res) => {
    const baseSnapshot = snapshotStore.getSnapshotById(req.params.baseId);
    const targetSnapshot = snapshotStore.getSnapshotById(req.params.targetId);
    if (!baseSnapshot || !targetSnapshot) {
      return res.status(404).json({ error: 'One or both snapshots were not found.' });
    }

    return res.json({
      baseSnapshot: snapshotStore.buildSnapshotSummary(baseSnapshot),
      targetSnapshot: snapshotStore.buildSnapshotSummary(targetSnapshot),
      comparison: snapshotStore.compareSnapshots(baseSnapshot, targetSnapshot),
    });
  });

  app.get('/api/snapshots/:id', (req, res) => {
    const snapshot = snapshotStore.getSnapshotById(req.params.id);
    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found.' });
    }
    return res.json(snapshot);
  });

  app.get('/healthz', (_req, res) => {
    const telemetry = marketApi.getTelemetry();
    res.json({
      ok: true,
      cacheLoaded: itemCache.items.length > 0,
      cacheAgeMs: itemCache.loadedAt ? nowMs() - itemCache.loadedAt : null,
      ...telemetry,
      timestamp: now().toISOString(),
    });
  });

  return app;
}

const app = createApp();

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Warframe arbitrage app running at http://localhost:${port}`);
  });
}

module.exports = {
  app,
  createApp,
  parseAnalysisOptions,
  analyzeSingleItem,
  getRecentCandidateItems,
  scoreExecutionConfidence,
  buildStressTest,
  formatVariantLabel,
  getHighOutlierFence,
  normalizeItem,
  compareSnapshots,
};
