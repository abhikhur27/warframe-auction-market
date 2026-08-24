const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  STORE_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  createSnapshotStore,
} = require('../snapshot-store');

const fixturesDir = path.join(__dirname, 'fixtures');

function createHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warframe-snapshot-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshotFile = path.join(root, 'data', 'session-snapshots.json');
  let id = 0;
  const store = createSnapshotStore({
    snapshotFile,
    maxSnapshots: options.maxSnapshots || 40,
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    idFactory: () => `snapshot-${++id}`,
  });
  return { root, snapshotFile, store };
}

function installFixture(snapshotFile, fixtureName) {
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  fs.copyFileSync(path.join(fixturesDir, fixtureName), snapshotFile);
}

function payload(analyzedAt, platform = 'pc') {
  return {
    analyzedAt,
    options: { platform, language: 'en', crossplay: true },
    result: [{
      item: { slug: 'arcane-energize', name: 'Arcane Energize' },
      variant: { rank: 5, subtype: null, label: 'Rank 5' },
      expectedProfit: 40,
      roiPct: 18.2,
    }],
  };
}

test('migrates a legacy array fixture into the versioned store without losing its route', (t) => {
  const { snapshotFile, store } = createHarness(t);
  installFixture(snapshotFile, 'snapshots-legacy-v0.json');

  const summaries = store.listSnapshotSummaries();
  const persisted = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));

  assert.equal(summaries.length, 1);
  assert.match(summaries[0].id, /^migrated-/);
  assert.equal(summaries[0].marketContext.label, 'PC | Crossplay | EN');
  assert.equal(summaries[0].topRoute.itemName, 'Arcane Energize');
  assert.equal(persisted.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(persisted.snapshots[0].schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.deepEqual(persisted.snapshots[0].options, {
    minSpread: 8,
    platform: 'pc',
    language: 'en',
    crossplay: true,
  });
  assert.ok(fs.existsSync(`${snapshotFile}.bak`));
});

test('loads a current fixture without changing explicit market context', (t) => {
  const { snapshotFile, store } = createHarness(t);
  installFixture(snapshotFile, 'snapshots-current-v2.json');

  const summaries = store.listSnapshotSummaries();
  const snapshot = store.getSnapshotById('fixture-xbox-current');

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].marketContext.label, 'Xbox | Platform only | EN');
  assert.equal(snapshot.options.platform, 'xbox');
  assert.equal(snapshot.options.crossplay, false);
  assert.equal(snapshot.options.minSpread, 10);
});

test('recovers the last known-good backup and quarantines a corrupt primary', (t) => {
  const { root, snapshotFile, store } = createHarness(t);
  store.createSnapshot('analyze', payload('2026-08-20T12:00:00.000Z'));
  store.createSnapshot('analyze', payload('2026-08-21T12:00:00.000Z'));
  fs.writeFileSync(snapshotFile, '{broken json', 'utf8');

  const summaries = store.listSnapshotSummaries();
  const repaired = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const quarantined = fs.readdirSync(path.dirname(snapshotFile))
    .filter((name) => name.includes('.corrupt-'));

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, 'snapshot-1');
  assert.equal(repaired.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(repaired.snapshots[0].id, 'snapshot-1');
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'data', quarantined[0]), 'utf8'), '{broken json');
});

test('retention keeps only the newest configured snapshots on disk and through the API', (t) => {
  const { snapshotFile, store } = createHarness(t, { maxSnapshots: 3 });
  for (let day = 1; day <= 5; day += 1) {
    store.createSnapshot('analyze', payload(`2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`));
  }

  const summaries = store.listSnapshotSummaries(99);
  const persisted = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));

  assert.deepEqual(summaries.map((entry) => entry.id), ['snapshot-5', 'snapshot-4', 'snapshot-3']);
  assert.deepEqual(persisted.snapshots.map((entry) => entry.id), ['snapshot-5', 'snapshot-4', 'snapshot-3']);
});

test('refuses to overwrite a store created by a newer application schema', (t) => {
  const { snapshotFile, store } = createHarness(t);
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  fs.writeFileSync(snapshotFile, JSON.stringify({ schemaVersion: 99, snapshots: [] }), 'utf8');

  assert.throws(
    () => store.listSnapshotSummaries(),
    /newer than supported/
  );
  assert.equal(JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).schemaVersion, 99);
});
