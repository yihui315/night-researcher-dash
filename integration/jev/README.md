# JEV Trading Desk adapter

This folder is a tested, provider-neutral frontend adapter prepared for the JEV React 19/Vite application.

## Mount target

Copy:
- `tradingApi.mjs`
- `tradingApi.d.ts`

to JEV's `src/features/trading/services/`, then import `createTradingApi` from the Trading Desk feature.

The adapter exposes `getProviderHealth()` against `/api/health`, and `listProviders()`, `probeProvider(providerId)`, and `listProviderModels(providerId)` against the existing JEV ProviderRegistry routes. It also exposes Trading Desk methods against `/api/v1/trading`. Known ProviderRegistry IDs include `typesafe_jev`, `minimax`, `qwen_coding_plan_cn`, `deepseek`, and `custom`. JEV Vite/production routing must proxy these paths to the local JEV backend on port 4779. Provider health being live does not imply the new trading routes exist. Do not point the cloud-hosted Pages preview at `127.0.0.1`.

## Credential and execution rules

- The UI loads provider choices and connection state from the existing ProviderRegistry; it passes `providerId`, never an API key.
- `/api/health`, Provider Center, and Mission Router must continue to share the same ProviderRegistry facts. Do not create a second credential registry inside Trading Desk.
- JEV ProviderRegistry / DPAPI SecretStore is the sole credential source.
- `createPaperOrder` requires an explicit `confirmationId`; the backend must validate it and independently re-read the market book/account before executing the deterministic paper engine.
- No live-order method exists in this adapter.
- The OpenAPI contract in `docs/jev-trading-openapi.yaml` is still planned; the adapter does not imply that these routes are already implemented in JEV.
