# Warframe Market v2 contract fixtures

These small, sanitized fixtures preserve the response envelope and the fields consumed by this app from:

- `GET /v2/items`
- `GET /v2/orders/recent`
- `GET /v2/orders/item/:slug`

They were checked against the live API shape on 2026-08-30. Names and prices are synthetic; no complete market response or user history is stored. Tests use the fixtures offline so upstream schema drift is separated from live market volatility.

The fixture set also includes localized catalog aliases, rank/subtype-separated orders, deliberately invalid envelopes, non-array collection data, malformed JSON, synthetic timeouts, rate limits, and an upstream response error. Those contracts prove that bounded retries and route-level partial failures remain visible while a fatal catalog or recent-order failure returns an explicit gateway error and does not archive a misleading scan.
