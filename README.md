# Warframe Arbitrage Market Scanner

Practical local web app for identifying Warframe flip opportunities from live `warframe.market` order flow.

This project is designed for **decision support** during manual trading, not fully automated trade execution.

## Core capabilities

- Finds the lowest viable `WTS` order (buy-in anchor).
- Finds multiple high-quality `WTB` buyers as fallback options.
- Scores opportunities by spread, ROI, and expected profit.
- Auto-find mode scans active market traffic and ranks candidates.
- Filters by status (`ingame`/`online`), reputation, order freshness, and trade quality.

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
  "maxResults": 25
}
```

## Opportunity model

Each candidate is evaluated in a variant bucket (`rank`/`subtype`) and includes:

- Buy anchor price (best seller).
- Buyer alternatives sorted by payout quality.
- Spread and ROI.
- Expected profit estimate.
- Liquidity hints (`buyOffers` vs `sellOffers`).
- Prebuilt whisper templates for faster execution.

## Performance and rate control

The server intentionally throttles external calls:

- max concurrent requests: `3`
- per-request delay: `360ms`

This lowers API pressure and reduces burst failures while scanning many items.

## Operational notes

- Prefer `ingame` and `online` counterparties for conversion speed.
- Keep multiple buyer options; first whisper failure is common.
- Freshness filtering (`maxAgeHours`) is important because stale quotes can distort ROI.
- Treat displayed profit as **pre-fee directional guidance**, not guaranteed realized outcome.

## Automation / autostart (optional)

- Keep-alive scheduled task: `WarframeFlipFinder-AutoStart`
- Startup script: `scripts/ensure-warframe-flip-finder.ps1`
- Startup hook: `WarframeFlipFinder-Autostart.bat` in your Windows Startup folder

## Roadmap

- Track realized fills vs predicted ROI to calibrate scoring.
- Add item-level volatility and response-rate heuristics.
- Add historical session snapshots for post-trade review.
