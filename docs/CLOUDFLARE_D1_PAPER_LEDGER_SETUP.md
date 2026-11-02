# Cloudflare D1 Server-Authoritative Paper Engine Setup

Status: P2 server engine is implemented in the feature branch. The UI fails closed until the D1 binding and signing secret are configured. No live exchange order endpoint exists.

Cloudflare D1 is SQLite-based storage managed by Cloudflare. It is the deployment-compatible SQLite layer for the Pages Functions runtime; this is not a local SQLite file and does not require a native SQLite package in the Worker.

## 1. Create the database and apply both migrations

From the repository root:

```bash
npx wrangler d1 create night-researcher-paper-ledger
```

Copy the returned database ID. Apply both migrations in order:

```bash
npx wrangler d1 execute night-researcher-paper-ledger --remote --file=migrations/0001_paper_ledger.sql
npx wrangler d1 execute night-researcher-paper-ledger --remote --file=migrations/0002_server_paper_engine.sql
```

The schema contains:

- `paper_sessions`: opaque browser session IDs, expiry and revocation state.
- `paper_events`: legacy append-only research audit events. Browser-originated snapshots remain untrusted and are not used as the authoritative account.
- `paper_accounts`: server-owned account state, version and SHA-256 state hash.
- `paper_orders`: normalized server-validated orders and status transitions; client order IDs are unique per session.
- `paper_fills`: normalized server-generated fills, unique by order and fill index.
- `paper_server_events`: append-only server execution events and hash-linked account snapshots used for recovery and replay.

## 2. Bind D1 to Cloudflare Pages

In Cloudflare Dashboard:

1. Open **Workers & Pages** → the `night-researcher-dash` Pages project.
2. Open **Settings** → **Functions** → **D1 database bindings**.
3. Add a binding named exactly `PAPER_DB`.
4. Select `night-researcher-paper-ledger`.
5. Configure the binding for Preview first. Use a separate Preview database from Production.
6. Only after Preview acceptance, configure the Production binding.

Do not point an unverified Preview deployment at the Production account database.

## 3. Add the signing secret

Generate a random secret locally; never commit or paste it into the repository:

```bash
openssl rand -base64 48
```

Add it as a Pages environment variable named `PAPER_LEDGER_SECRET` for Preview. Use a value of at least 32 characters. Redeploy the Pages project after changing bindings or variables. Configure Production separately after Preview passes.

## 4. Server API

- `POST /api/paper/session`: creates or reuses a 7-day session. The signed token is set in a `Secure; HttpOnly; SameSite=Strict` cookie scoped to `/api/`.
- `GET /api/paper/account`: returns the server-owned account and server-fetched mark prices. The browser cannot submit an account balance or positions.
- `POST /api/paper/orders`: accepts only order intent, client idempotency ID and confirmation ID. The server re-reads Binance public depth, exchange filters and ticker marks before validation and deterministic matching.
- `POST /api/paper/orders/:orderId/cancel`: cancels an open server-side order and releases its reservation.
- `POST /api/paper/market/tick`: accepts only a whitelisted symbol. The server ignores client market data and fetches a fresh book before attempting limit-order fills.
- `POST /api/paper/account/reset`: requires explicit client action and confirmation IDs; the reset is recorded and prior server events remain in the audit history.
- `GET /api/paper/events?after=0&limit=100`: reads the server-generated event stream.
- `GET /api/paper/replay`: verifies the SHA-256-linked account snapshot chain and reconstructs the latest recoverable account state.
- `POST /api/paper/ledger` and `GET /api/paper/ledger`: legacy research/audit journal; these events do not control paper account state.

The server validates same-origin writes, HMAC session signatures, session expiry, allowlisted symbols, Binance LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL constraints, visible order-book depth, available cash/spot inventory, idempotency and account-version concurrency. The deterministic risk gates remain: 10% per order, 40% maximum marked exposure, 3% UTC daily-loss circuit breaker, 10% account drawdown circuit breaker, no leverage and no naked shorts.

Market orders use IOC-style visible-depth walking. Limit orders reserve cash or spot inventory, can partially fill, and are processed at most once per Binance depth sequence. Every state mutation writes the account version, normalized order/fill rows and a server event in one D1 batch. A repeated client order ID cannot create a second fill; a concurrent account-version conflict fails closed.

API keys are not part of the paper engine contract. No wallet, exchange credential or live order route is used.

## 5. UI behavior and trust boundary

The Trading Desk now treats the server as the only account authority:

- **服务端权威账本已连接**: the D1-backed account was read successfully.
- **服务端引擎不可用 · 已禁止下单**: D1, the signing secret or the API is unavailable. The UI does not fall back to browser-local execution.
- **回放校验通过**: the server event snapshots and current materialized account match.

The browser no longer saves or restores the account from `localStorage`. Legacy browser snapshots in `paper_events` are not consulted by the server execution engine. Research-agent events remain a separate audit stream.

Limit orders are currently advanced by the active Trading Desk polling `/api/paper/market/tick`; each request causes the server to fetch the book itself. If the browser is closed, pending limit orders are not actively polled in this P2 deployment. A scheduled Worker/Cron or Durable Object runner is a required follow-on before unattended continuous operation.

The server-generated account snapshots contain the complete recoverable state, while order-created, fill, reject, cancel and reset events preserve the execution trail. `GET /api/paper/replay` checks the state-hash chain and returns the last valid snapshot. This is a paper-only execution ledger, not a live trading engine.

## 6. Preview verification checklist

After configuring Preview D1 and the Preview signing secret:

1. Open the Preview Trading Desk and confirm **服务端权威账本已连接**.
2. Confirm the browser has no authoritative account key in local storage.
3. Submit a small market paper order. Verify the server returns an order ID, a server book sequence and a server-generated fill.
4. Re-submit the same client order ID with the same parameters. Confirm the existing order is returned and no second fill is created.
5. Re-use the same client order ID with different parameters. Confirm the server rejects it with `IDEMPOTENCY_CONFLICT`.
6. Place a non-marketable limit order. Confirm cash or inventory is reserved, partial fills are recorded, and a repeated book sequence cannot fill twice.
7. Cancel an open order and confirm its reservation is released.
8. Clear browser local storage and reload. Confirm the account is restored from D1.
9. Click **校验并回放** and confirm the server reports a valid snapshot chain.
10. Confirm the strategy gates remain closed for all strategies that have not passed independent OOS validation.

Do not test by clearing all site cookies: that intentionally creates a new anonymous paper session. Do not use a Production database for Preview testing.
