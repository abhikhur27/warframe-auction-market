const state = {
  selectedItems: [],
  suggestions: [],
};

const itemInput = document.getElementById('item-input');
const addItemButton = document.getElementById('add-item');
const clearItemsButton = document.getElementById('clear-items');
const bulkItemsInput = document.getElementById('items-bulk');
const chipsEl = document.getElementById('item-chips');
const suggestionsEl = document.getElementById('suggestions');
const analyzeButton = document.getElementById('analyze');
const autoFindButton = document.getElementById('auto-find');
const copyShareLinkButton = document.getElementById('copy-share-link');
const loadingEl = document.getElementById('loading');
const summaryEl = document.getElementById('summary');
const marketPostureEl = document.getElementById('market-posture');
const resultsEl = document.getElementById('results');
const copyOpportunitiesButton = document.getElementById('copy-opportunities');
const copyTopRouteButton = document.getElementById('copy-top-route');
const exportResultsMarkdownButton = document.getElementById('export-results-md');
const exportResultsJsonButton = document.getElementById('export-results-json');
const exportResultsCsvButton = document.getElementById('export-results-csv');
const resultSortSelect = document.getElementById('result-sort');
const refreshSnapshotsButton = document.getElementById('refresh-snapshots');
const snapshotStatusEl = document.getElementById('snapshot-status');
const snapshotListEl = document.getElementById('snapshot-list');
const snapshotCompareEl = document.getElementById('snapshot-compare');
const template = document.getElementById('result-template');
let lastResultsPayload = null;

function normalizeName(value) {
  return String(value || '').trim();
}

function addItem(name) {
  const normalized = normalizeName(name);
  if (!normalized) return;

  const exists = state.selectedItems.some((item) => item.toLowerCase() === normalized.toLowerCase());
  if (exists) return;

  state.selectedItems.push(normalized);
  renderChips();
  syncUrlState();
}

function removeItem(name) {
  state.selectedItems = state.selectedItems.filter((item) => item !== name);
  renderChips();
  syncUrlState();
}

function renderChips() {
  chipsEl.innerHTML = '';
  for (const item of state.selectedItems) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = item;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'x';
    removeBtn.addEventListener('click', () => removeItem(item));

    chip.append(removeBtn);
    chipsEl.append(chip);
  }
}

function renderSuggestions() {
  suggestionsEl.innerHTML = '';
  for (const suggestion of state.suggestions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suggestion';
    btn.textContent = suggestion.name;
    btn.addEventListener('click', () => {
      addItem(suggestion.name);
      itemInput.value = '';
      state.suggestions = [];
      renderSuggestions();
    });
    suggestionsEl.append(btn);
  }
}

async function fetchSuggestions(query) {
  if (!query.trim()) {
    state.suggestions = [];
    renderSuggestions();
    return;
  }

  try {
    const resp = await fetch(`/api/items?q=${encodeURIComponent(query)}&limit=8`);
    const data = await resp.json();
    state.suggestions = Array.isArray(data.items) ? data.items : [];
    renderSuggestions();
  } catch (_err) {
    state.suggestions = [];
    renderSuggestions();
  }
}

function getStatuses() {
  return [...document.querySelectorAll('input[name="status"]:checked')].map((el) => el.value);
}

function setLoading(message) {
  loadingEl.textContent = message || '';
}

function setSummary(text, isError = false) {
  summaryEl.textContent = text;
  summaryEl.classList.toggle('error', Boolean(isError));
}

function readFormState() {
  return {
    items: state.selectedItems,
    platform: document.getElementById('platform').value,
    crossplay: document.getElementById('crossplay').value,
    minSpread: document.getElementById('min-spread').value,
    minRoi: document.getElementById('min-roi').value,
    minExpectedProfit: document.getElementById('min-expected-profit').value,
    minLiquidityOffers: document.getElementById('min-liquidity-offers').value,
    minRep: document.getElementById('min-rep').value,
    maxAge: document.getElementById('max-age').value,
    buyerOptions: document.getElementById('buyer-options').value,
    sellerOptions: document.getElementById('seller-options').value,
    maxResults: document.getElementById('max-results').value,
    resultSort: resultSortSelect.value,
    statuses: getStatuses(),
  };
}

function syncUrlState() {
  const params = new URLSearchParams();
  const formState = readFormState();

  if (formState.items.length) params.set('items', formState.items.join('\n'));
  params.set('platform', formState.platform);
  params.set('crossplay', formState.crossplay);
  params.set('minSpread', formState.minSpread);
  params.set('minRoi', formState.minRoi);
  params.set('minExpectedProfit', formState.minExpectedProfit);
  params.set('minLiquidityOffers', formState.minLiquidityOffers);
  params.set('minRep', formState.minRep);
  params.set('maxAge', formState.maxAge);
  params.set('buyerOptions', formState.buyerOptions);
  params.set('sellerOptions', formState.sellerOptions);
  params.set('maxResults', formState.maxResults);
  params.set('resultSort', formState.resultSort);
  if (formState.statuses.length) params.set('statuses', formState.statuses.join(','));

  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

function hydrateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const fieldMap = [
    ['platform', 'platform'],
    ['crossplay', 'crossplay'],
    ['minSpread', 'min-spread'],
    ['minRoi', 'min-roi'],
    ['minExpectedProfit', 'min-expected-profit'],
    ['minLiquidityOffers', 'min-liquidity-offers'],
    ['minRep', 'min-rep'],
    ['maxAge', 'max-age'],
    ['buyerOptions', 'buyer-options'],
    ['sellerOptions', 'seller-options'],
    ['maxResults', 'max-results'],
  ];

  fieldMap.forEach(([paramName, elementId]) => {
    const value = params.get(paramName);
    const element = document.getElementById(elementId);
    if (value && element) {
      element.value = value;
    }
  });

  const requestedSort = params.get('resultSort');
  if (requestedSort && resultSortSelect.querySelector(`option[value="${requestedSort}"]`)) {
    resultSortSelect.value = requestedSort;
  }

  const statuses = (params.get('statuses') || '').split(',').filter(Boolean);
  if (statuses.length) {
    document.querySelectorAll('input[name="status"]').forEach((checkbox) => {
      checkbox.checked = statuses.includes(checkbox.value);
    });
  }

  const items = (params.get('items') || '')
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length) {
    state.selectedItems = [];
    items.forEach((item) => {
      const exists = state.selectedItems.some((existing) => existing.toLowerCase() === item.toLowerCase());
      if (!exists) {
        state.selectedItems.push(item);
      }
    });
  }
}

async function copyShareLink() {
  syncUrlState();
  try {
    await navigator.clipboard.writeText(window.location.href);
    setSummary('Copied the current scanner setup link.', false);
  } catch (_err) {
    setSummary('Clipboard copy failed for the scanner setup link.', true);
  }
}

function metric(label, value) {
  const span = document.createElement('span');
  span.className = 'metric';
  span.textContent = `${label}: ${value}`;
  return span;
}

function fmtTime(value) {
  if (!value) return 'unknown';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

function personLine(user) {
  const status = user?.status || 'offline';
  const name = user?.ingameName || 'Unknown';
  const rep = user?.reputation ?? 0;
  return `${name} | ${status} | rep ${rep}`;
}

function offerDetails(offer) {
  const wrapper = document.createElement('div');
  wrapper.className = 'secondary';
  wrapper.textContent = `${personLine(offer.seller || offer.buyer)} | qty ${offer.quantity} | per trade ${offer.perTrade} | updated ${fmtTime(offer.updatedAt)}`;
  return wrapper;
}

function offerWhisper(offer) {
  const code = document.createElement('code');
  code.textContent = offer.whisper;
  return code;
}

function ageFromIsoHours(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, (Date.now() - parsed) / (1000 * 60 * 60));
}

function classifyRoutePosture(row) {
  const topBuyer = row.buyerOptions?.[0];
  const freshestAge = Math.max(
    ageFromIsoHours(row.bestSell?.updatedAt) ?? 48,
    ageFromIsoHours(topBuyer?.updatedAt) ?? 48
  );
  const liquidity = (row.liquidity?.buyOffers || 0) + (row.liquidity?.sellOffers || 0);
  const backupDepth = (row.sellerAlternatives?.length || 0) + (row.buyerOptions?.length || 0) - 1;

  if (row.executionScore >= 72 && freshestAge <= 12 && liquidity >= 6) {
    return {
      tone: 'stable',
      label: 'Stable route',
      note: `Fresh quotes, ${liquidity} visible counterparties, and enough backup depth to survive one failed whisper.`,
    };
  }

  if (row.executionScore >= 54 && freshestAge <= 24 && liquidity >= 4) {
    return {
      tone: 'watch',
      label: 'Watchlist route',
      note: `Usable spread, but freshness or counterpart depth is only moderate. Recheck before committing plat.`,
    };
  }

  return {
    tone: 'speculative',
    label: 'Speculative route',
    note: `Profit looks real, but the route is thin or stale. Treat it as a quick probe, not a dependable farm line.`,
  };
}

function renderMarketPosture(rows) {
  if (!marketPostureEl) return;
  if (!rows.length) {
    marketPostureEl.textContent = 'Run a scan to get a route posture summary.';
    marketPostureEl.className = 'posture-card muted';
    return;
  }

  const postureRows = rows.map((row) => ({ row, posture: classifyRoutePosture(row) }));
  const stable = postureRows.filter((entry) => entry.posture.tone === 'stable');
  const speculative = postureRows.filter((entry) => entry.posture.tone === 'speculative');
  const bestStable = stable.sort((left, right) => right.row.expectedProfit - left.row.expectedProfit)[0];
  const top = postureRows[0];
  const label = stable.length >= Math.ceil(rows.length / 2)
    ? 'Stable market posture'
    : speculative.length >= Math.ceil(rows.length / 2)
      ? 'Fragile market posture'
      : 'Mixed market posture';

  const note = bestStable
    ? `Best stable route: ${bestStable.row.item.name} ${bestStable.row.variant.label} at ${bestStable.row.expectedProfit}p expected profit.`
    : `Top route needs caution: ${top.row.item.name} ${top.row.variant.label} reads as ${top.posture.label.toLowerCase()}.`;

  marketPostureEl.className = 'posture-card';
  marketPostureEl.innerHTML = [
    `<strong>${label}</strong>`,
    `${stable.length} stable, ${rows.length - stable.length - speculative.length} watchlist, ${speculative.length} speculative route${speculative.length === 1 ? '' : 's'}.`,
    note,
  ].join('<br>');
}

function snapshotLabel(snapshot) {
  return snapshot.kind === 'auto-find' ? 'Auto-find snapshot' : 'Analyze snapshot';
}

function topRouteLine(snapshot) {
  const top = snapshot.topRoute;
  if (!top) return 'No qualifying routes were captured.';
  return `${top.itemName} ${top.variantLabel} | ${top.expectedProfit}p expected | ${top.roiPct}% ROI`;
}

function formatSigned(value, suffix = '') {
  const numeric = Number(value || 0);
  const prefix = numeric > 0 ? '+' : '';
  return `${prefix}${numeric}${suffix}`;
}

function comparisonRouteLine(route) {
  return `${route.itemName} ${route.variantLabel} | ${formatSigned(route.profitDelta, 'p')} expected | ${formatSigned(route.roiDelta, '%')} ROI | ${formatSigned(route.executionDelta)} execution`;
}

function renderSnapshotComparison(payload) {
  const comparison = payload?.comparison;
  if (!comparison || !snapshotCompareEl) return;

  const baseTime = new Date(payload.baseSnapshot.analyzedAt).toLocaleString();
  const targetTime = new Date(payload.targetSnapshot.analyzedAt).toLocaleString();
  const lines = [
    `<strong>Latest-vs-earlier route drift</strong>`,
    `${targetTime} compared with ${baseTime}. ${comparison.overlapCount} overlapping routes, ${comparison.newCount} new, ${comparison.droppedCount} missing.`,
    `Average matched change: ${formatSigned(comparison.averageProfitDelta, 'p')} expected profit and ${formatSigned(comparison.averageRoiDelta, '%')} ROI.`,
  ];

  if (comparison.topImproved.length) {
    lines.push('Best improvements:');
    lines.push(`<ul>${comparison.topImproved.map((route) => `<li>${comparisonRouteLine(route)}</li>`).join('')}</ul>`);
  }

  if (comparison.topDecayed.length) {
    lines.push('Biggest decay:');
    lines.push(`<ul>${comparison.topDecayed.map((route) => `<li>${comparisonRouteLine(route)}</li>`).join('')}</ul>`);
  }

  if (comparison.newRoutes.length) {
    lines.push('New routes in the latest run:');
    lines.push(`<ul>${comparison.newRoutes.map((route) => `<li>${route.itemName} ${route.variantLabel} | ${route.expectedProfit}p expected | ${route.roiPct}% ROI</li>`).join('')}</ul>`);
  }

  snapshotCompareEl.classList.remove('muted');
  snapshotCompareEl.innerHTML = lines.join('<br>');
}

function renderSnapshots(snapshots) {
  snapshotListEl.innerHTML = '';

  if (!snapshots.length) {
    snapshotStatusEl.textContent = 'No snapshots recorded yet. Run Analyze or Auto Find to build review history.';
    return;
  }

  snapshotStatusEl.textContent = `Showing ${snapshots.length} recent local scan snapshot${snapshots.length === 1 ? '' : 's'}.`;
  const latestSnapshot = snapshots[0];
  snapshots.forEach((snapshot) => {
    const card = document.createElement('article');
    card.className = 'snapshot-card';
    const primaryCount = Number.isFinite(snapshot.resolvedCount)
      ? `${snapshot.resolvedCount} resolved`
      : Number.isFinite(snapshot.scannedCount)
        ? `${snapshot.scannedCount} scanned`
        : 'Review only';
    const compareButton = latestSnapshot && latestSnapshot.id !== snapshot.id
      ? `<button type="button" class="ghost" data-compare-base-id="${snapshot.id}" data-compare-target-id="${latestSnapshot.id}">Compare With Latest</button>`
      : '';
    card.innerHTML = `
      <header>
        <div>
          <h3>${snapshotLabel(snapshot)}</h3>
          <p class="secondary">${new Date(snapshot.analyzedAt).toLocaleString()} | ${snapshot.resultCount} routes | ${primaryCount}</p>
        </div>
        <div class="snapshot-actions">
          <button type="button" class="ghost" data-snapshot-id="${snapshot.id}">Review Snapshot</button>
          ${compareButton}
        </div>
      </header>
      <p class="secondary">${topRouteLine(snapshot)}</p>
    `;
    snapshotListEl.append(card);
  });

  snapshotListEl.querySelectorAll('[data-snapshot-id]').forEach((button) => {
    button.addEventListener('click', () => reviewSnapshot(button.dataset.snapshotId));
  });
  snapshotListEl.querySelectorAll('[data-compare-base-id]').forEach((button) => {
    button.addEventListener('click', () => compareSnapshotPair(button.dataset.compareBaseId, button.dataset.compareTargetId));
  });
}

async function loadSnapshots() {
  snapshotStatusEl.textContent = 'Loading recent snapshots...';
  snapshotListEl.innerHTML = '';
  try {
    const resp = await fetch('/api/snapshots?limit=8');
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data?.error || 'Snapshot history failed to load.');
    }
    renderSnapshots(Array.isArray(data.snapshots) ? data.snapshots : []);
  } catch (_err) {
    snapshotStatusEl.textContent = 'Snapshot history failed to load.';
  }
}

async function reviewSnapshot(snapshotId) {
  if (!snapshotId) return;
  try {
    setLoading('Loading snapshot...');
    const resp = await fetch(`/api/snapshots/${encodeURIComponent(snapshotId)}`);
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data?.error || 'Snapshot review failed.');
    }
    renderResults(data);
    setSummary(`Viewing ${snapshotLabel(data).toLowerCase()} from ${new Date(data.analyzedAt).toLocaleString()}.`, false);
  } catch (_err) {
    setSummary('Failed to load that snapshot.', true);
  } finally {
    setLoading('');
  }
}

async function compareSnapshotPair(baseSnapshotId, targetSnapshotId) {
  if (!baseSnapshotId || !targetSnapshotId) return;
  try {
    setLoading('Comparing snapshots...');
    const resp = await fetch(`/api/snapshots/compare/${encodeURIComponent(baseSnapshotId)}/${encodeURIComponent(targetSnapshotId)}`);
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data?.error || 'Snapshot comparison failed.');
    }
    renderSnapshotComparison(data);
    setSummary(`Compared the latest snapshot against ${new Date(data.baseSnapshot.analyzedAt).toLocaleString()}.`, false);
  } catch (_err) {
    setSummary('Failed to compare those snapshots.', true);
  } finally {
    setLoading('');
  }
}

function renderResults(payload) {
  lastResultsPayload = payload;
  resultsEl.innerHTML = '';
  const rows = sortResultRows(payload.result || []);
  renderMarketPosture(rows);

  if (rows.length === 0) {
    setSummary('No opportunities passed your filters. Lower thresholds or include more items.', false);
    return;
  }

  const hasResolved = Number.isFinite(payload.resolvedCount);
  const hasScanned = Number.isFinite(payload.scannedCount);
  if (hasResolved) {
    setSummary(`Found ${rows.length} opportunities from ${payload.resolvedCount} resolved item(s).`, false);
  } else if (hasScanned) {
    setSummary(`Found ${rows.length} opportunities while scanning ${payload.scannedCount} active item(s).`, false);
  } else {
    setSummary(`Found ${rows.length} opportunities.`, false);
  }

  for (const row of rows) {
    const node = template.content.firstElementChild.cloneNode(true);
    const posture = classifyRoutePosture(row);

    node.querySelector('.item-name').textContent = row.item.name;
    node.querySelector('.variant').textContent = row.variant.label;
    const postureBadge = node.querySelector('.posture-badge');
    postureBadge.textContent = posture.label;
    postureBadge.classList.add(posture.tone);
    node.querySelector('.posture-note').textContent = posture.note;

    const metrics = node.querySelector('.metrics');
    metrics.append(metric('Spread', `${row.spread}p`));
    metrics.append(metric('ROI', `${row.roiPct}%`));
    metrics.append(metric('Expected', `${row.expectedProfit}p`));
    metrics.append(metric('Execution', `${row.executionScore}/100`));
    metrics.append(metric('Qty', row.recommendedQuantity));
    metrics.append(metric('Liquidity', `WTS ${row.liquidity.sellOffers} / WTB ${row.liquidity.buyOffers}`));

    const bestSell = node.querySelector('.best-sell');
    bestSell.innerHTML = `<div class="price">${row.bestSell.price}p</div>`;
    bestSell.append(offerDetails(row.bestSell));
    bestSell.append(offerWhisper(row.bestSell));

    const sellers = node.querySelector('.backup-sellers');
    sellers.innerHTML = '';
    if (!row.sellerAlternatives.length) {
      const li = document.createElement('li');
      li.textContent = 'No backups matched filters.';
      sellers.append(li);
    } else {
      for (const seller of row.sellerAlternatives) {
        const li = document.createElement('li');
        const block = document.createElement('div');
        block.className = 'seller-row';
        block.innerHTML = `<div class="price">${seller.price}p</div>`;
        block.append(offerDetails(seller));
        block.append(offerWhisper(seller));
        li.append(block);
        sellers.append(li);
      }
    }

    const buyers = node.querySelector('.buyer-options');
    buyers.innerHTML = '';
    for (const buyer of row.buyerOptions) {
      const li = document.createElement('li');
      const block = document.createElement('div');
      block.className = 'buyer-row';
      block.innerHTML = `<div class="price">${buyer.price}p</div>`;
      const detail = document.createElement('div');
      detail.className = 'secondary';
      detail.textContent = `Spread ${buyer.spread}p | ROI ${buyer.roiPct}% | Expected ${buyer.expectedProfit}p`;
      block.append(detail);
      block.append(offerDetails(buyer));
      block.append(offerWhisper(buyer));
      li.append(block);
      buyers.append(li);
    }

    resultsEl.append(node);
  }
}

function buildOpportunityBrief() {
  const rows = sortResultRows(lastResultsPayload?.result || []);
  if (!rows.length) {
    return 'No opportunities available.';
  }

  const header = summaryEl.textContent || `Found ${rows.length} opportunities.`;
  const lines = rows.slice(0, 5).map((row, index) => {
    const topBuyer = row.buyerOptions?.[0];
    return `${index + 1}. ${row.item.name} ${row.variant.label} | buy ${row.bestSell.price}p | sell ${topBuyer?.price ?? '?'}p | spread ${row.spread}p | ROI ${row.roiPct}% | qty ${row.recommendedQuantity}`;
  });

  return ['Warframe Opportunity Brief', header, ...lines].join('\n');
}

function buildTopRouteBrief() {
  const rows = sortResultRows(lastResultsPayload?.result || []);
  if (!rows.length) {
    return 'No opportunities available.';
  }

  const top = rows[0];
  const buyer = top.buyerOptions?.[0];
  if (!buyer) {
    return 'Top opportunity does not have a buyer route yet.';
  }

  return [
    `${top.item.name} ${top.variant.label}`,
    `Buy: ${top.bestSell.whisper}`,
    `Sell: ${buyer.whisper}`,
    `Spread ${top.spread}p | ROI ${top.roiPct}% | Expected ${top.expectedProfit}p | Qty ${top.recommendedQuantity}`,
  ].join('\n');
}

function buildMarkdownBrief() {
  const rows = sortResultRows(lastResultsPayload?.result || []);
  if (!rows.length) {
    return 'No opportunities available.';
  }

  const formState = readFormState();
  const lines = [
    '# Warframe Opportunity Brief',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Platform: ${formState.platform.toUpperCase()}`,
    `- Statuses: ${formState.statuses.join(', ') || 'none'}`,
    `- Filters: min spread ${formState.minSpread}p, min ROI ${formState.minRoi}%, min expected profit ${formState.minExpectedProfit}p, min offers ${formState.minLiquidityOffers}, max age ${formState.maxAge}h`,
    `- Result sort: ${resultSortSelect.options[resultSortSelect.selectedIndex].text}`,
    `- Summary: ${summaryEl.textContent || `Found ${rows.length} opportunities.`}`,
    '',
    '## Top routes',
  ];

  rows.slice(0, 8).forEach((row, index) => {
    const posture = classifyRoutePosture(row);
    const buyer = row.buyerOptions?.[0];
    lines.push(`### ${index + 1}. ${row.item.name} (${row.variant.label})`);
    lines.push(`- Route posture: ${posture.label} - ${posture.note}`);
    lines.push(`- Buy anchor: ${row.bestSell.price}p from ${personLine(row.bestSell.seller)}`);
    lines.push(`- Top buyer: ${buyer ? `${buyer.price}p from ${personLine(buyer.buyer)}` : 'none'}`);
    lines.push(`- Spread / ROI / Expected: ${row.spread}p / ${row.roiPct}% / ${row.expectedProfit}p`);
    lines.push(`- Execution / Liquidity: ${row.executionScore}/100 | WTS ${row.liquidity.sellOffers} / WTB ${row.liquidity.buyOffers}`);
    lines.push(`- Buy whisper: \`${row.bestSell.whisper}\``);
    if (buyer?.whisper) {
      lines.push(`- Sell whisper: \`${buyer.whisper}\``);
    }
    lines.push('');
  });

  return lines.join('\n');
}

function buildCommonPayload() {
  return {
    platform: document.getElementById('platform').value,
    crossplay: document.getElementById('crossplay').value,
    statuses: getStatuses(),
    minSpread: Number(document.getElementById('min-spread').value),
    minRoiPct: Number(document.getElementById('min-roi').value),
    minExpectedProfit: Number(document.getElementById('min-expected-profit').value),
    minLiquidityOffers: Number(document.getElementById('min-liquidity-offers').value),
    minReputation: Number(document.getElementById('min-rep').value),
    maxAgeHours: Number(document.getElementById('max-age').value),
    buyerOptionCount: Number(document.getElementById('buyer-options').value),
    sellerOptionCount: Number(document.getElementById('seller-options').value),
  };
}

function downloadBlob(name, body, type) {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function runAnalysisRequest(url, payload, startMessage) {
  try {
    setLoading('Running...');
    setSummary(startMessage, false);
    analyzeButton.disabled = true;
    autoFindButton.disabled = true;
    copyOpportunitiesButton.disabled = true;
    lastResultsPayload = null;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();

    if (!resp.ok) {
      const message = data?.error || 'Analysis failed.';
      setSummary(message, true);
      resultsEl.innerHTML = '';
      return;
    }

    renderResults(data);
    loadSnapshots();

    if (data.unresolved?.length) {
      setSummary(`${summaryEl.textContent} Unresolved: ${data.unresolved.join(', ')}`, false);
    }
  } catch (_err) {
    setSummary('Failed to analyze. Check that the server is running and try again.', true);
    resultsEl.innerHTML = '';
  } finally {
    analyzeButton.disabled = false;
    autoFindButton.disabled = false;
    copyOpportunitiesButton.disabled = !(lastResultsPayload?.result || []).length;
    copyTopRouteButton.disabled = !(lastResultsPayload?.result || []).length;
    exportResultsMarkdownButton.disabled = !(lastResultsPayload?.result || []).length;
    exportResultsJsonButton.disabled = !(lastResultsPayload?.result || []).length;
    exportResultsCsvButton.disabled = !(lastResultsPayload?.result || []).length;
    setLoading('');
  }
}

function sortResultRows(rows) {
  const mode = resultSortSelect.value;
  const sorted = [...rows];

  sorted.sort((a, b) => {
    if (mode === 'roi') {
      return b.roiPct - a.roiPct || b.expectedProfit - a.expectedProfit;
    }
    if (mode === 'spread') {
      return b.spread - a.spread || b.expectedProfit - a.expectedProfit;
    }
    if (mode === 'liquidity') {
      const liquidityA = (a.liquidity?.buyOffers || 0) + (a.liquidity?.sellOffers || 0);
      const liquidityB = (b.liquidity?.buyOffers || 0) + (b.liquidity?.sellOffers || 0);
      return liquidityB - liquidityA || b.expectedProfit - a.expectedProfit;
    }
    if (mode === 'confidence') {
      return (b.executionScore || 0) - (a.executionScore || 0) || b.expectedProfit - a.expectedProfit;
    }
    return b.expectedProfit - a.expectedProfit || b.roiPct - a.roiPct;
  });

  return sorted;
}

async function analyze() {
  const bulkTokens = bulkItemsInput.value
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  for (const token of bulkTokens) addItem(token);

  if (state.selectedItems.length === 0) {
    setSummary('Add at least one item first.', true);
    return;
  }

  const statuses = getStatuses();
  if (statuses.length === 0) {
    setSummary('Pick at least one status (ingame/online/offline).', true);
    return;
  }

  const payload = {
    ...buildCommonPayload(),
    items: state.selectedItems,
  };
  await runAnalysisRequest('/api/analyze', payload, 'Analyzing live orders...');
}

async function autoFind() {
  const statuses = getStatuses();
  if (statuses.length === 0) {
    setSummary('Pick at least one status (ingame/online/offline).', true);
    return;
  }

  const payload = {
    ...buildCommonPayload(),
    maxResults: Number(document.getElementById('max-results').value),
  };
  await runAnalysisRequest('/api/auto-find', payload, 'Auto scanning active market items...');
}

addItemButton.addEventListener('click', () => {
  if (itemInput.value.trim()) {
    addItem(itemInput.value);
    itemInput.value = '';
    state.suggestions = [];
    renderSuggestions();
  }
});

clearItemsButton.addEventListener('click', () => {
  state.selectedItems = [];
  renderChips();
  syncUrlState();
});

itemInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (itemInput.value.trim()) {
      addItem(itemInput.value);
      itemInput.value = '';
      state.suggestions = [];
      renderSuggestions();
    }
  }
});

let suggestionTimer = null;
itemInput.addEventListener('input', () => {
  clearTimeout(suggestionTimer);
  const value = itemInput.value;
  suggestionTimer = setTimeout(() => {
    fetchSuggestions(value);
  }, 160);
});

analyzeButton.addEventListener('click', analyze);
autoFindButton.addEventListener('click', autoFind);
copyShareLinkButton.addEventListener('click', copyShareLink);
copyOpportunitiesButton.addEventListener('click', async () => {
  const brief = buildOpportunityBrief();
  if (brief === 'No opportunities available.') {
    setSummary('Run an analysis first so there is something useful to copy.', true);
    return;
  }

  try {
    await navigator.clipboard.writeText(brief);
    setSummary('Copied a top-opportunity brief for quick whisper routing.', false);
  } catch (_err) {
    setSummary('Clipboard copy failed in this environment.', true);
  }
});
copyTopRouteButton.addEventListener('click', async () => {
  const brief = buildTopRouteBrief();
  if (brief === 'No opportunities available.' || brief === 'Top opportunity does not have a buyer route yet.') {
    setSummary(brief, true);
    return;
  }

  try {
    await navigator.clipboard.writeText(brief);
    setSummary('Copied the top buy/sell whisper route.', false);
  } catch (_err) {
    setSummary('Clipboard copy failed in this environment.', true);
  }
});
exportResultsMarkdownButton.addEventListener('click', () => {
  const markdown = buildMarkdownBrief();
  if (markdown === 'No opportunities available.') {
    setSummary('Run an analysis first so there is something useful to export.', true);
    return;
  }

  downloadBlob('warframe-opportunity-brief.md', markdown, 'text/markdown');
  setSummary('Exported the current opportunity set as Markdown.', false);
});
exportResultsJsonButton.addEventListener('click', () => {
  if (!(lastResultsPayload?.result || []).length) {
    setSummary('Run an analysis first so there is something useful to export.', true);
    return;
  }

  downloadBlob('warframe-flip-results.json', JSON.stringify(lastResultsPayload, null, 2), 'application/json');
  setSummary('Exported the current opportunity set as JSON.', false);
});
exportResultsCsvButton.addEventListener('click', () => {
  const rows = lastResultsPayload?.result || [];
  if (!rows.length) {
    setSummary('Run an analysis first so there is something useful to export.', true);
    return;
  }

  const csvRows = ['item,variant,spread,roi_pct,expected_profit,recommended_quantity,best_sell,best_buy'];
  rows.forEach((row) => {
    csvRows.push([
      `"${row.item.name}"`,
      `"${row.variant.label}"`,
      row.spread,
      row.roiPct,
      row.expectedProfit,
      row.recommendedQuantity,
      row.bestSell.price,
      row.buyerOptions?.[0]?.price ?? '',
    ].join(','));
  });

  downloadBlob('warframe-flip-results.csv', csvRows.join('\n'), 'text/csv');
  setSummary('Exported the current opportunity set as CSV.', false);
});
copyOpportunitiesButton.disabled = true;
copyTopRouteButton.disabled = true;
exportResultsMarkdownButton.disabled = true;
exportResultsJsonButton.disabled = true;
exportResultsCsvButton.disabled = true;
refreshSnapshotsButton.addEventListener('click', loadSnapshots);
resultSortSelect.addEventListener('change', () => {
  syncUrlState();
  if (lastResultsPayload) {
    renderResults(lastResultsPayload);
    setSummary(`Resorted ${lastResultsPayload.result.length} opportunities by ${resultSortSelect.options[resultSortSelect.selectedIndex].text.toLowerCase()}.`, false);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.altKey) return;
  if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;

  event.preventDefault();
  if (event.shiftKey) {
    autoFind();
    return;
  }
  analyze();
});

document
  .querySelectorAll('select, input[type="number"], input[name="status"]')
  .forEach((element) => element.addEventListener('change', syncUrlState));

hydrateFromUrl();
if (state.selectedItems.length) {
  renderChips();
} else {
  [
    'arcane energize',
    'primed continuity',
    'revenant prime set',
    'glaive prime set',
    'adaptation',
    'axi g6 relic'
  ].forEach(addItem);
}
syncUrlState();
loadSnapshots();
