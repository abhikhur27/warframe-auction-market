const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SNAPSHOT_DIR = path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'session-snapshots.json');
const MAX_SNAPSHOTS = 40;
const DEFAULT_MARKET_CONTEXT = Object.freeze({
  platform: 'pc',
  language: 'en',
  crossplay: true,
});

function ensureSnapshotDir() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

function readSnapshots() {
  ensureSnapshotDir();
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSnapshots(snapshots) {
  ensureSnapshotDir();
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshots, null, 2));
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).trim().toLowerCase() === 'true';
}

function normalizeIdentityPart(value, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized || fallback;
}

function normalizeMarketContext(options = {}) {
  const platform = normalizeIdentityPart(options.platform, DEFAULT_MARKET_CONTEXT.platform);
  const language = normalizeIdentityPart(options.language, DEFAULT_MARKET_CONTEXT.language);
  const crossplay = normalizeBoolean(options.crossplay, DEFAULT_MARKET_CONTEXT.crossplay);
  const platformLabels = {
    pc: 'PC',
    ps4: 'PlayStation',
    xbox: 'Xbox',
    switch: 'Switch',
  };

  return {
    platform,
    language,
    crossplay,
    key: [platform, language, crossplay ? 'crossplay' : 'platform-only'].join('::'),
    label: `${platformLabels[platform] || platform.toUpperCase()} | ${crossplay ? 'Crossplay' : 'Platform only'} | ${language.toUpperCase()}`,
  };
}

function buildVariantIdentity(variant = {}) {
  const rank = Number.isInteger(variant.rank) ? variant.rank : null;
  const subtype = normalizeIdentityPart(variant.subtype, '');

  if (rank !== null || subtype) {
    return `rank=${rank ?? 'none'}::subtype=${subtype || 'none'}`;
  }

  return `legacy=${normalizeIdentityPart(variant.label, 'default')}`;
}

function buildRouteFingerprint(row, options = {}) {
  const context = normalizeMarketContext(options);
  const itemIdentity = normalizeIdentityPart(row?.item?.slug || row?.item?.name, 'unknown-item');
  const variantIdentity = buildVariantIdentity(row?.variant);
  return ['route-v2', context.key, itemIdentity, variantIdentity].join('::');
}

function buildSnapshotSummary(snapshot) {
  const top = snapshot.result?.[0];
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    analyzedAt: snapshot.analyzedAt,
    resultCount: Array.isArray(snapshot.result) ? snapshot.result.length : 0,
    requestedCount: snapshot.requestedCount ?? null,
    resolvedCount: snapshot.resolvedCount ?? null,
    scannedCount: snapshot.scannedCount ?? null,
    marketContext: normalizeMarketContext(snapshot.options),
    topRoute: top ? {
      itemName: top.item?.name || 'Unknown item',
      variantLabel: top.variant?.label || 'Default',
      expectedProfit: top.expectedProfit ?? 0,
      roiPct: top.roiPct ?? 0,
    } : null,
  };
}

function createSnapshot(kind, payload) {
  const result = Array.isArray(payload.result) ? payload.result : [];
  const snapshot = {
    id: crypto.randomUUID(),
    kind,
    analyzedAt: payload.analyzedAt || new Date().toISOString(),
    options: payload.options || {},
    requestedCount: payload.requestedCount ?? null,
    resolvedCount: payload.resolvedCount ?? null,
    unresolved: Array.isArray(payload.unresolved) ? payload.unresolved : [],
    scannedCount: payload.scannedCount ?? null,
    candidateCount: payload.candidateCount ?? null,
    analysisBudget: payload.analysisBudget ?? null,
    errors: Array.isArray(payload.errors) ? payload.errors : [],
    result,
  };

  const snapshots = readSnapshots();
  snapshots.unshift(snapshot);
  writeSnapshots(snapshots.slice(0, MAX_SNAPSHOTS));
  return snapshot;
}

function listSnapshotSummaries(limit = 12) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, MAX_SNAPSHOTS));
  return readSnapshots().slice(0, safeLimit).map(buildSnapshotSummary);
}

function getSnapshotById(id) {
  return readSnapshots().find((snapshot) => snapshot.id === id) || null;
}

function summarizeRoute(row, options = {}) {
  const topBuyer = Array.isArray(row?.buyerOptions) ? row.buyerOptions[0] : null;
  const routeFingerprint = buildRouteFingerprint(row, options);
  return {
    key: routeFingerprint,
    routeFingerprint,
    marketContext: normalizeMarketContext(options),
    itemName: row?.item?.name || 'Unknown item',
    variantLabel: row?.variant?.label || 'Default',
    expectedProfit: Number(row?.expectedProfit || 0),
    roiPct: Number(row?.roiPct || 0),
    executionScore: Number(row?.executionScore || 0),
    buyPrice: Number(row?.bestSell?.price || 0),
    sellPrice: Number(topBuyer?.price || 0),
  };
}

function buildRouteMomentum(history, currentRoute) {
  const previous = history[0] || null;
  if (!previous) {
    return {
      label: 'New route',
      tone: 'new',
      note: 'This route has not appeared in recent local snapshots yet.',
      seenCount: 0,
      averageProfitDelta: 0,
      averageExecutionDelta: 0,
      latestProfitDelta: 0,
      latestExecutionDelta: 0,
      lastSeenAt: null,
      bestRecentProfit: 0,
      history: [],
    };
  }

  const profitDeltas = history.map((entry) => currentRoute.expectedProfit - entry.expectedProfit);
  const executionDeltas = history.map((entry) => currentRoute.executionScore - entry.executionScore);
  const averageProfitDelta = Number((profitDeltas.reduce((sum, value) => sum + value, 0) / history.length).toFixed(1));
  const averageExecutionDelta = Number((executionDeltas.reduce((sum, value) => sum + value, 0) / history.length).toFixed(1));
  const latestProfitDelta = Number((currentRoute.expectedProfit - previous.expectedProfit).toFixed(1));
  const latestExecutionDelta = Number((currentRoute.executionScore - previous.executionScore).toFixed(1));
  const bestRecentProfit = history.reduce(
    (maxProfit, entry) => Math.max(maxProfit, entry.expectedProfit),
    Number(previous.expectedProfit || 0)
  );

  let tone = 'stable';
  let label = 'Stable route';
  let note = `Seen in ${history.length} recent snapshot${history.length === 1 ? '' : 's'} with only small drift.`;

  if (latestProfitDelta >= 8 || averageProfitDelta >= 6 || latestExecutionDelta >= 6) {
    tone = 'improving';
    label = 'Improving route';
    note = `Up ${latestProfitDelta > 0 ? '+' : ''}${latestProfitDelta}p vs the last matching snapshot with ${latestExecutionDelta > 0 ? '+' : ''}${latestExecutionDelta} execution drift.`;
  } else if (latestProfitDelta <= -8 || averageProfitDelta <= -6 || latestExecutionDelta <= -6) {
    tone = 'decaying';
    label = 'Decaying route';
    note = `Down ${latestProfitDelta}p vs the last matching snapshot with ${latestExecutionDelta > 0 ? '+' : ''}${latestExecutionDelta} execution drift.`;
  }

  return {
    label,
    tone,
    note,
    seenCount: history.length,
    averageProfitDelta,
    averageExecutionDelta,
    latestProfitDelta,
    latestExecutionDelta,
    lastSeenAt: previous.analyzedAt || null,
    bestRecentProfit,
    history: history.map((entry) => ({
      analyzedAt: entry.analyzedAt,
      expectedProfit: entry.expectedProfit,
      roiPct: entry.roiPct,
      executionScore: entry.executionScore,
    })),
  };
}

function attachSnapshotContext(resultRows, snapshots, currentOptions = {}, historyLimit = 3) {
  const rows = Array.isArray(resultRows) ? resultRows : [];
  const priorSnapshots = Array.isArray(snapshots) ? snapshots : [];
  const routeHistory = new Map();

  for (const snapshot of priorSnapshots) {
    const analyzedAt = snapshot?.analyzedAt || null;
    const routes = Array.isArray(snapshot?.result) ? snapshot.result : [];
    for (const route of routes) {
      const summary = summarizeRoute(route, snapshot?.options);
      if (!routeHistory.has(summary.key)) {
        routeHistory.set(summary.key, []);
      }

      const history = routeHistory.get(summary.key);
      if (history.length >= historyLimit) continue;
      history.push({
        ...summary,
        analyzedAt,
      });
    }
  }

  return rows.map((row) => {
    const summary = summarizeRoute(row, currentOptions);
    const history = routeHistory.get(summary.key) || [];
    return {
      ...row,
      routeFingerprint: summary.routeFingerprint,
      momentum: buildRouteMomentum(history, summary),
    };
  });
}

function emptyComparison(baseContext, targetContext, compatible, message) {
  return {
    compatible,
    message,
    baseMarketContext: baseContext,
    targetMarketContext: targetContext,
    overlapCount: 0,
    improvedCount: 0,
    decayedCount: 0,
    mixedCount: 0,
    unchangedCount: 0,
    newCount: 0,
    droppedCount: 0,
    averageProfitDelta: 0,
    averageRoiDelta: 0,
    topImproved: [],
    topDecayed: [],
    mixedRoutes: [],
    newRoutes: [],
    droppedRoutes: [],
  };
}

function classifyRouteChange(route) {
  const deltas = [route.profitDelta, route.roiDelta, route.executionDelta];
  const hasGain = deltas.some((value) => value > 0);
  const hasLoss = deltas.some((value) => value < 0);
  if (hasGain && hasLoss) return 'mixed';
  if (hasGain) return 'improved';
  if (hasLoss) return 'decayed';
  return 'unchanged';
}

function compareSnapshots(baseSnapshot, targetSnapshot) {
  const baseContext = normalizeMarketContext(baseSnapshot?.options);
  const targetContext = normalizeMarketContext(targetSnapshot?.options);

  if (baseContext.key !== targetContext.key) {
    return emptyComparison(
      baseContext,
      targetContext,
      false,
      `These snapshots cover different markets (${baseContext.label} vs ${targetContext.label}), so route drift was not calculated.`
    );
  }

  const baseRoutes = Array.isArray(baseSnapshot?.result)
    ? baseSnapshot.result.map((route) => summarizeRoute(route, baseSnapshot?.options))
    : [];
  const targetRoutes = Array.isArray(targetSnapshot?.result)
    ? targetSnapshot.result.map((route) => summarizeRoute(route, targetSnapshot?.options))
    : [];

  const baseMap = new Map(baseRoutes.map((route) => [route.key, route]));
  const targetMap = new Map(targetRoutes.map((route) => [route.key, route]));

  const matched = [];
  const newRoutes = [];
  const droppedRoutes = [];

  for (const route of targetRoutes) {
    const previous = baseMap.get(route.key);
    if (!previous) {
      newRoutes.push(route);
      continue;
    }

    matched.push({
      key: route.key,
      itemName: route.itemName,
      variantLabel: route.variantLabel,
      previousProfit: previous.expectedProfit,
      currentProfit: route.expectedProfit,
      profitDelta: Number((route.expectedProfit - previous.expectedProfit).toFixed(1)),
      previousRoiPct: previous.roiPct,
      currentRoiPct: route.roiPct,
      roiDelta: Number((route.roiPct - previous.roiPct).toFixed(1)),
      previousExecutionScore: previous.executionScore,
      currentExecutionScore: route.executionScore,
      executionDelta: Number((route.executionScore - previous.executionScore).toFixed(1)),
      previousBuyPrice: previous.buyPrice,
      currentBuyPrice: route.buyPrice,
      previousSellPrice: previous.sellPrice,
      currentSellPrice: route.sellPrice,
    });
  }

  for (const route of baseRoutes) {
    if (!targetMap.has(route.key)) {
      droppedRoutes.push(route);
    }
  }

  const classified = matched.map((route) => ({
    ...route,
    change: classifyRouteChange(route),
  }));
  const improvedRoutes = classified
    .filter((route) => route.change === 'improved')
    .sort((left, right) => right.profitDelta - left.profitDelta || right.executionDelta - left.executionDelta);
  const decayedRoutes = classified
    .filter((route) => route.change === 'decayed')
    .sort((left, right) => left.profitDelta - right.profitDelta || left.executionDelta - right.executionDelta);
  const mixedRoutes = classified
    .filter((route) => route.change === 'mixed')
    .sort((left, right) => Math.abs(right.profitDelta) - Math.abs(left.profitDelta));
  const unchangedCount = classified.filter((route) => route.change === 'unchanged').length;

  const profitDeltaTotal = matched.reduce((sum, route) => sum + route.profitDelta, 0);
  const roiDeltaTotal = matched.reduce((sum, route) => sum + route.roiDelta, 0);

  return {
    compatible: true,
    message: `Compared routes within ${baseContext.label}.`,
    baseMarketContext: baseContext,
    targetMarketContext: targetContext,
    overlapCount: matched.length,
    improvedCount: improvedRoutes.length,
    decayedCount: decayedRoutes.length,
    mixedCount: mixedRoutes.length,
    unchangedCount,
    newCount: newRoutes.length,
    droppedCount: droppedRoutes.length,
    averageProfitDelta: matched.length ? Number((profitDeltaTotal / matched.length).toFixed(1)) : 0,
    averageRoiDelta: matched.length ? Number((roiDeltaTotal / matched.length).toFixed(1)) : 0,
    topImproved: improvedRoutes.slice(0, 5),
    topDecayed: decayedRoutes.slice(0, 5),
    mixedRoutes: mixedRoutes.slice(0, 5),
    newRoutes: newRoutes.slice(0, 5),
    droppedRoutes: droppedRoutes.slice(0, 5),
  };
}

module.exports = {
  SNAPSHOT_FILE,
  MAX_SNAPSHOTS,
  createSnapshot,
  listSnapshotSummaries,
  getSnapshotById,
  buildSnapshotSummary,
  buildRouteFingerprint,
  normalizeMarketContext,
  compareSnapshots,
  attachSnapshotContext,
};
