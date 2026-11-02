# Cloudflare D1 Paper Ledger Setup

Status: implementation is in the feature branch. The Pages API intentionally stays in local-only mode until the D1 binding and server signing secret are configured.

## 1. Create the database

From the repository root, create a D1 database:

```bash
npx wrangler d1 create night-researcher-paper-ledger
```

Copy the returned database ID. Apply the schema:

```bash
npx wrangler d1 execute night-researcher-paper-ledger --remote --file=migrations/0001_paper_ledger.sql
```

The migration creates:
- `paper_sessions`: opaque browser session IDs, expiry and revocation state.
- `paper_events`: append-only events with per-session idempotency keys and monotonically increasing sequence IDs.

## 2. Bind D1 to Cloudflare Pages

In Cloudflare Dashboard:

1. Open **Workers & Pages** → the `night-researcher-dash` Pages project.
2. Open **Settings** → **Functions** → **D1 database bindings**.
3. Add a binding named exactly `PAPER_DB`.
4. Select `night-researcher-paper-ledger`.
5. Configure the binding for both Preview and Production environments. Use a separate Preview database if you want isolated test data.

## 3. Add the signing secret

Generate a random secret locally; never commit or paste it into the repository:

```bash
openssl rand -base64 48
```

Add it as a Pages environment variable named `PAPER_LEDGER_SECRET` for Preview and Production. Use a value of at least 32 characters. Redeploy the Pages project after changing bindings or variables.

## 4. Endpoints

- `POST /api/paper/session`: creates or reuses a 7-day session. The signed token is set in a `Secure; HttpOnly; SameSite=Strict` cookie scoped to `/api/`, so the trusted research endpoint can append its own audit records.
- `POST /api/paper/ledger`: append 1–20 allowlisted events. Repeated event IDs are idempotent.
- `GET /api/paper/ledger?after=0&limit=50`: read events after a sequence cursor.
- `GET /api/paper/ledger?latest=1&eventType=paper.account.snapshot&limit=1`: recover the newest account snapshot.

The server enforces same-origin requests, HMAC session signatures, session expiry/revocation, a 150 KB per-event payload cap and a 10,000-event per-session cap. API keys are never part of the ledger contract. The browser endpoint can append paper-account snapshots only; `agent.run.*`, `risk.decision` and `paper.server.order.*` events are reserved for trusted server code.

## 5. UI behavior and trust boundary

The Trading Desk displays one of these states:
- **服务端备份已同步**: the browser snapshot was appended to D1.
- **已从服务端恢复模拟账户**: the latest saved snapshot restored the browser's paper account.
- **仅本地 / 云端同步失败**: D1 or the signing secret is not configured, or the service is unavailable. Local simulation remains available.

Important: this first D1 milestone is an **append-only audit and recovery journal**, not yet an authoritative execution ledger. The account snapshot originates from the browser's paper engine and is therefore untrusted for Kelly sizing, strategy promotion, or any live-trading decision. Agent run start/completion/failure events are now written by the Pages Function itself (not the browser), including run ID, snapshot hash, prompt/model metadata, exact input snapshot, outputs and token usage. The server does not accept live orders and does not claim to independently recompute paper fills. The next milestone is moving deterministic paper-order validation and fills into the trusted JEV/Worker backend and writing server-generated order/fill events.

## 6. Verification

After deployment, open the Trading Desk and confirm the status changes to **服务端备份已同步**. Place a small paper-only order, refresh the page, and verify the account snapshot is restored. Clear only the browser local storage (leave the HttpOnly session cookie intact), reload, and verify the latest server snapshot restores the account.

Do not test by clearing all site cookies: that intentionally creates a new anonymous paper session.
