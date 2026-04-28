# Warframe Flip Finder

Local web app that checks `warframe.market` live orders and highlights actionable spreads:

- Cheapest matching `WTS` order (your buy-in)
- Multiple `WTB` fallback buyers (if first whisper fails)
- ROI/profit filters so only worthwhile flips show up
- Auto-find mode that scans active market items and ranks best opportunities

## Run

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Auto-start on your machine

- Keep-alive scheduled task: `WarframeFlipFinder-AutoStart`
- Startup script: `scripts/ensure-warframe-flip-finder.ps1`
- User startup hook: `WarframeFlipFinder-Autostart.bat` in your Startup folder

This setup ensures the app comes back after sign-in and gets checked every few minutes.

## How it works

- Loads items from `https://api.warframe.market/v2/items`
- Fetches orders from `https://api.warframe.market/v2/orders/item/{slug}`
- Uses `https://api.warframe.market/v2/orders/recent` to discover active items for auto mode
- Compares matching variant buckets (rank/subtype)
- Filters by status, reputation, age, spread, ROI

## Notes

- Keep request rates modest (app throttles to 3 concurrent with delay).
- "In game" and "Online" usually give the best conversion.
- Include backup buyers because no-reply/changed-mind happens often.
