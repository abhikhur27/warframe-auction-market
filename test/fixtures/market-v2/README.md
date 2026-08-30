# Warframe Market v2 contract fixtures

These small, sanitized fixtures preserve the response envelope and the fields consumed by this app from:

- `GET /v2/items`
- `GET /v2/orders/recent`
- `GET /v2/orders/item/:slug`

They were checked against the live API shape on 2026-08-30. Names and prices are synthetic; no complete market response or user history is stored. Tests use the fixtures offline so upstream schema drift is separated from live market volatility.
