const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SNAPSHOT_DIR = path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'session-snapshots.json');
const MAX_SNAPSHOTS = 40;

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

function summarizeRoute(row) {
  const topBuyer = Array.isArray(row?.buyerOptions) ? row.buyerOptions[0] : null;
  return {
    key: [
      row?.item?.slug || row?.item?.name || 'unknown-item',
      row?.variant?.label || 'Default',
    ].join('::'),
    itemName: row?.item?.name || 'Unknown item',
    variantLabel: row?.variant?.label || 'Default',
    expectedProfit: Number(row?.expectedProfit || 0),
    roiPct: Number(row?.roiPct || 0),
    executionScore: Number(row?.executionScore || 0),
    buyPrice: Number(row?.bestSell?.price || 0),
    sellPrice: Number(topBuyer?.price || 0),
  };
}

function compareSnapshots(baseSnapshot, targetSnapshot) {
  const baseRoutes = Array.isArray(baseSnapshot?.result) ? baseSnapshot.result.map(summarizeRoute) : [];
  const targetRoutes = Array.isArray(targetSnapshot?.result) ? targetSnapshot.result.map(summarizeRoute) : [];

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

  const improvedRoutes = matched
    .filter((route) => route.profitDelta > 0 || route.executionDelta > 0)
    .sort((left, right) => right.profitDelta - left.profitDelta || right.executionDelta - left.executionDelta);
  const decayedRoutes = matched
    .filter((route) => route.profitDelta < 0 || route.executionDelta < 0)
    .sort((left, right) => left.profitDelta - right.profitDelta || left.executionDelta - right.executionDelta);
  const unchangedCount = matched.length - improvedRoutes.length - decayedRoutes.length;

  const profitDeltaTotal = matched.reduce((sum, route) => sum + route.profitDelta, 0);
  const roiDeltaTotal = matched.reduce((sum, route) => sum + route.roiDelta, 0);

  return {
    overlapCount: matched.length,
    improvedCount: improvedRoutes.length,
    decayedCount: decayedRoutes.length,
    unchangedCount,
    newCount: newRoutes.length,
    droppedCount: droppedRoutes.length,
    averageProfitDelta: matched.length ? Number((profitDeltaTotal / matched.length).toFixed(1)) : 0,
    averageRoiDelta: matched.length ? Number((roiDeltaTotal / matched.length).toFixed(1)) : 0,
    topImproved: improvedRoutes.slice(0, 5),
    topDecayed: decayedRoutes.slice(0, 5),
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
  compareSnapshots,
};
