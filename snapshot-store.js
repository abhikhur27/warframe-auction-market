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

module.exports = {
  SNAPSHOT_FILE,
  MAX_SNAPSHOTS,
  createSnapshot,
  listSnapshotSummaries,
  getSnapshotById,
  buildSnapshotSummary,
};
