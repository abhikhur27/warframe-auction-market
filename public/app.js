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
const loadingEl = document.getElementById('loading');
const summaryEl = document.getElementById('summary');
const resultsEl = document.getElementById('results');
const template = document.getElementById('result-template');

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
}

function removeItem(name) {
  state.selectedItems = state.selectedItems.filter((item) => item !== name);
  renderChips();
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

function renderResults(payload) {
  resultsEl.innerHTML = '';
  const rows = payload.result || [];

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

    node.querySelector('.item-name').textContent = row.item.name;
    node.querySelector('.variant').textContent = row.variant.label;

    const metrics = node.querySelector('.metrics');
    metrics.append(metric('Spread', `${row.spread}p`));
    metrics.append(metric('ROI', `${row.roiPct}%`));
    metrics.append(metric('Expected', `${row.expectedProfit}p`));
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

function buildCommonPayload() {
  return {
    platform: document.getElementById('platform').value,
    crossplay: document.getElementById('crossplay').value,
    statuses: getStatuses(),
    minSpread: Number(document.getElementById('min-spread').value),
    minProfit: Number(document.getElementById('min-profit').value),
    minRoiPct: Number(document.getElementById('min-roi').value),
    minReputation: Number(document.getElementById('min-rep').value),
    maxAgeHours: Number(document.getElementById('max-age').value),
    buyerOptionCount: Number(document.getElementById('buyer-options').value),
    sellerOptionCount: Number(document.getElementById('seller-options').value),
  };
}

async function runAnalysisRequest(url, payload, startMessage) {
  try {
    setLoading('Running...');
    setSummary(startMessage, false);
    analyzeButton.disabled = true;
    autoFindButton.disabled = true;

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

    if (data.unresolved?.length) {
      setSummary(`${summaryEl.textContent} Unresolved: ${data.unresolved.join(', ')}`, false);
    }
  } catch (_err) {
    setSummary('Failed to analyze. Check that the server is running and try again.', true);
    resultsEl.innerHTML = '';
  } finally {
    analyzeButton.disabled = false;
    autoFindButton.disabled = false;
    setLoading('');
  }
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
    scanLimit: Number(document.getElementById('scan-limit').value),
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

(function preloadWatchlist() {
  [
    'arcane energize',
    'primed continuity',
    'revenant prime set',
    'glaive prime set',
    'adaptation',
    'axi g6 relic'
  ].forEach(addItem);
})();
