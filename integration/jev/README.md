# JEV Trading Desk adapter

This folder is a tested, provider-neutral frontend adapter prepared for the JEV React 19/Vite application.

## Mount target

Copy:
- `tradingApi.mjs`
- `tradingApi.d.ts`

to JEV's `src/features/trading/services/`, then import `createTradingApi` from the Trading Desk feature.

The default base path is same-origin `/api/v1/trading`; JEV Vite/production routing must proxy that path to the local JEV backend on port 4779. Do not point the cloud-hosted Pages preview at `127.0.0.1`.

## Credential and execution rules

- The UI passes `providerId`, never an API key.
- JEV ProviderRegistry / DPAPI SecretStore is the sole credential source.
- `createPaperOrder` requires an explicit `confirmationId`; the backend must validate it and independently re-read the market book/account before executing the deterministic paper engine.
- No live-order method exists in this adapter.
- The OpenAPI contract in `docs/jev-trading-openapi.yaml` is still planned; the adapter does not imply that these routes are already implemented in JEV.
