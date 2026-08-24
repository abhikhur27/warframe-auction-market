# Warframe Arbitrage Market Scanner

Practical local web app for identifying Warframe flip opportunities from live `warframe.market` order flow.

This project is designed for **decision support** during manual trading, not fully automated trade execution.

## Core capabilities

- Finds the lowest viable `WTS` order (buy-in anchor).
- Finds multiple high-quality `WTB` buyers as fallback options.
- Scores opportunities by spread, ROI, and expected profit.
- Adds an execution-confidence score so fresh, liquid routes surface above brittle one-off spreads.
- Classifies each route as stable, watchlist, or speculative so high profit does not hide stale or thin execution paths.
- Lets the result deck be re-sorted by expected profit, ROI, spread, liquidity, or execution confidence depending on trading posture.
- Auto-find mode scans active market traffic and ranks candidates.
- Current result sets can be exported as JSON or CSV after a scan.
- Current result sets can also be exported as a Markdown trading brief for quick review or Discord/notes sharing.
- Every analyze/auto-find run is now archived as a local snapshot so you can review earlier route boards without hitting the live API again.
- Reviewing a saved snapshot restores the same Copy and Export actions as a live scan.
- Older snapshots can be compared against the latest run so route decay, fresh openings, and profit swings are visible without manual diffing.
- Current route cards now use recent snapshot history to label each line as new, improving, stable, or decaying so one lucky spread does not get mistaken for a durable market edge.
- Snapshot momentum and comparisons use versioned route fingerprints that include market, crossplay, item, rank, and subtype identity, preventing console or variant scans from being blended into a false trend.
- Snapshot comparisons refuse cross-market drift calculations and classify conflicting profit/ROI/execution movement as mixed instead of double-counting it as both improved and decayed.
- Snapshot history uses a versioned on-disk schema, automatically migrates legacy array files, retains the newest 40 runs, and writes through a temporary file with a last-known-good backup.
- If the primary snapshot file is malformed, the store quarantines it and restores the backup instead of silently replacing history with an empty list; newer unsupported schemas are left untouched.
- Shareable URL state keeps the current watchlist and filter setup reproducible.
- Item lookup now accepts both `/api/items` and the older `/api/items/search` path so saved scripts and README-era probes still work.
- Power-user shortcuts: `Ctrl/Cmd+Enter` runs Analyze and `Ctrl/Cmd+Shift+Enter` runs Auto-Find.
- Filters by status (`ingame`/`online`), reputation, order freshness, and trade quality.
- Filters now include a minimum expected-profit threshold so low-yield flips do not crowd out better trades.
- Filters can now require minimum fallback profit so brittle top-of-book routes do not outrank routes with real backup depth.
- Filters can require a minimum number of buy and sell offers so one-off spikes do not masquerade as liquid opportunities.
- Copies a top-opportunity brief for faster whisper routing outside the app.

## Stack

- Node.js + Express
- Plain HTML/CSS/JS frontend (`public/`)
- Warframe Market v2 API

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Project structure

```text
.
├── public/
│   ├── index.html      # UI shell
│   ├── styles.css      # Dashboard styling
│   └── app.js          # Client behavior and API calls
├── scripts/
│   └── ensure-warframe-flip-finder.ps1  # Optional keep-alive/autostart setup
├── server.js           # API orchestration, scoring, filtering
└── README.md
```

## API endpoints

### `GET /api/health`

Basic liveness probe.

### `GET /api/items?q=<query>&limit=<n>`

Item lookup with fuzzy matching from cached item metadata.

### `POST /api/analyze`

Analyze specific item names/slugs.

Example payload:

```json
{
  "items": ["arcane energize", "primed continuity"],
  "platform": "pc",
  "language": "en",
  "crossplay": true,
  "statuses": ["ingame", "online"],
  "minReputation": 8,
  "minSpread": 6,
  "minRoiPct": 10,
  "minConservativeProfit": 12,
  "buyerOptionCount": 4,
  "sellerOptionCount": 3,
  "maxAgeHours": 48
}
```

### `POST /api/auto-find`

Scans recent active orders and ranks top opportunities.

Example payload:

```json
{
  "platform": "pc",
  "crossplay": true,
  "statuses": ["ingame", "online"],
  "minReputation": 8,
  "minSpread": 6,
  "minRoiPct": 10,
  "minConservativeProfit": 12,
  "maxResults": 25
}
```

### `GET /api/snapshots?limit=<n>`

Returns recent local scan snapshot summaries for post-trade review.

### `GET /api/snapshots/:id`

Returns one saved local snapshot, including the captured result deck and filters.

### `GET /api/snapshots/compare/:baseId/:targetId`

Compares two saved snapshots and summarizes matched-route profit drift, ROI drift, and new or missing routes.

## Opportunity model

Each candidate is evaluated in a variant bucket (`rank`/`subtype`) and includes:

- Buy anchor price (best seller).
- Buyer alternatives sorted by payout quality.
- Fallback-route stress test using the second-best buyer and seller when available.
- Spread and ROI.
- Expected profit estimate.
- Conservative profit retention so one failed whisper does not hide route fragility.
- Liquidity hints (`buyOffers` vs `sellOffers`).
- Prebuilt whisper templates for faster execution.

## Performance and rate control

The server intentionally throttles external calls:

- max concurrent requests: `3`
- per-request delay: `360ms`

Health telemetry endpoint:

- `GET /healthz` returns cache state, queue depth, active request count, and server timestamp.

This lowers API pressure and reduces burst failures while scanning many items.

## Operational notes

- Prefer `ingame` and `online` counterparties for conversion speed.
- Keep multiple buyer options; first whisper failure is common.
- Freshness filtering (`maxAgeHours`) is important because stale quotes can distort ROI.
- Treat displayed profit as **pre-fee directional guidance**, not guaranteed realized outcome.
- Snapshot history is stored locally in `data/session-snapshots.json` and is ignored by git.
- The previous valid snapshot document is kept at `data/session-snapshots.json.bak`; malformed primaries are preserved as timestamped `.corrupt-*` files for manual recovery.
- Route momentum is derived from the recent local snapshot history only; a route marked `New` can still be strong, it just lacks local replay context.
- Only snapshots from the same platform, language, and crossplay market are comparable. Filter thresholds may differ without changing route identity.

## Automation / autostart (optional)

- Keep-alive scheduled task: `WarframeFlipFinder-AutoStart`
- Startup script: `scripts/ensure-warframe-flip-finder.ps1`
- Startup hook: `WarframeFlipFinder-Autostart.bat` in your Windows Startup folder

## Roadmap

- Track realized fills vs predicted ROI to calibrate scoring.
- Add item-level volatility and response-rate heuristics.

## Sanity Check Sequence

Run this quick sequence after server changes:

1. `npm start`
2. `GET /healthz` and verify `ok: true`.
3. Query `GET /api/items?q=arcane` (or the legacy `/api/items/search?q=arcane` alias).
4. Run one `POST /api/analyze` payload with 2 known items.
5. Confirm `GET /api/snapshots?limit=3` returns the new run.

For deterministic verification of migration, backup recovery, retention, and market-context compatibility, run `npm test`.
The test suite writes only to operating-system temporary directories and never clears your local `data/` history.

## Portfolio Positioning

- Project type: Node.js + Express web app
- Verification path: npm install && npm start, then hit `/health`, test `/api/analyze`, and confirm snapshot history loads.

