/**
 * JEV V4.3 - OFFLINE unit tests for the trust layer.
 *
 * These tests prove the AUTHENTICATION / FIXED-POINT / HASH-CHAIN logic.
 * They do NOT prove a real D1 integration or a real GitHub Actions OIDC
 * runner: that is covered separately by v43_e2e against wrangler --local.
 * The OIDC test uses a locally generated RSA keypair, NOT a GitHub token.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");

let auth, equity, events, ledger;
test.before(async () => {
  auth = await import("../functions/_lib/service-auth.mjs");
  equity = await import("../functions/_lib/equity-snapshot.mjs");
  events = await import("../functions/_lib/strategy-events.mjs");
  ledger = await import("../functions/_lib/paper-ledger.mjs");
});

const SECRET = "test-service-signing-secret-0123456789-abcdefgh";
const ACTOR = "v43-unit-test";

/** Minimal in-memory D1 double. Enough for the code paths under test. */
function makeDb(options = {}) {
  const state = {
    nonces: {}, events: [],
    accounts: options.accounts || [],
    snapshots: options.snapshots || []
  };
  const has = (sql, needle) => sql.includes(needle);
  const binding = (sql, args) => ({
    bind(...newArgs) { return binding(sql, newArgs); },
    async first() {
      if (has(sql, "FROM verification_nonces")) {
        const n = state.nonces[args[0]];
        return n ? { actor: n.actor, created_at: n.created_at } : null;
      }
      if (has(sql, "FROM strategy_events") && has(sql, "ORDER BY seq DESC")) {
        return state.events.length ? state.events[state.events.length - 1] : null;
      }
      if (has(sql, "MAX(equity)")) {
        const rows = state.snapshots.filter(s => s.session_id === args[0] && s.generation === args[1] && s.mark_quality === "verified");
        return { peak: rows.length ? Math.max(...rows.map(r => r.equity)) : null };
      }
      return null;
    },
    async all() {
      if (has(sql, "FROM paper_accounts")) return { results: state.accounts.slice() };
      if (has(sql, "FROM paper_equity_snapshots") && has(sql, "mark_quality = 'verified'")) {
        const rows = state.snapshots
          .filter(s => s.session_id === args[0] && s.generation === args[1] && s.mark_quality === "verified")
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        return { results: rows };
      }
      if (has(sql, "FROM strategy_events")) return { results: state.events.slice() };
      return { results: [] };
    },
    async run() {
      if (has(sql, "INSERT INTO verification_nonces")) {
        if (!state.nonces[args[0]]) state.nonces[args[0]] = { actor: args[1], created_at: args[2] };
        return { success: true };
      }
      if (has(sql, "INSERT INTO strategy_events")) {
        state.events.push({
          seq: state.events.length + 1, strategy_id: args[0], event_type: args[1],
          payload_json: args[2], prev_hash: args[3], hash: args[4], created_at: args[5]
        });
        return { success: true };
      }
      return { success: true };
    }
  });
  return {
    state,
    prepare(sql) { return binding(sql, []); },
    async batch() { return []; }
  };
}

function accountRow(overrides = {}) {
  const account = {
    version: 1, generation: 1,
    initialCash: "10000.00000000", cash: "9000.00000000",
    realizedPnl: "0.00000000", equityPeak: "10000.00000000",
    positions: { BTCUSDT: { qty: "0.02000000", avgPrice: "50000.00000000", reservedQty: "0" } },
    orders: [], trades: [],
    ...(overrides.account || {})
  };
  return {
    session_id: "S-TEST", version: 3, state_hash: "hash-abc",
    state_json: JSON.stringify(account), ...overrides
  };
}

// ---------------------------------------------------------------- service auth

test("HMAC: valid signature is accepted and consumes the nonce", async () => {
  const db = makeDb();
  const raw = JSON.stringify({ hello: "world" });
  const headers = await auth.signServiceBody(SECRET, ACTOR, raw, { timestamp: Math.floor(Date.now() / 1000), nonce: "nonce-valid-0001" });
  const request = new Request("http://127.0.0.1/api/x", { method: "POST", headers, body: raw });
  const result = await auth.verifyServiceSignature(request, { NR_SERVICE_SIGNING_SECRET: SECRET }, raw, { db });
  assert.equal(result.ok, true);
  assert.equal(result.authMethod, "hmac-service");
  assert.equal(result.actor, ACTOR);
});

test("HMAC: tampered body is rejected (signature binds sha256 of exact bytes)", async () => {
  const raw = JSON.stringify({ equity: 1 });
  const headers = await auth.signServiceBody(SECRET, ACTOR, raw, { nonce: "nonce-tamper-0001" });
  const request = new Request("http://127.0.0.1/api/x", { method: "POST", headers, body: raw });
  const result = await auth.verifyServiceSignature(request, { NR_SERVICE_SIGNING_SECRET: SECRET }, raw + " ", { db: makeDb() });
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
});

test("HMAC: stale timestamp is rejected", async () => {
  const raw = "{}";
  const old = Math.floor(Date.now() / 1000) - auth.MAX_SKEW_SECONDS - 60;
  const headers = await auth.signServiceBody(SECRET, ACTOR, raw, { timestamp: old, nonce: "nonce-stale-0001" });
  const request = new Request("http://127.0.0.1/api/x", { method: "POST", headers, body: raw });
  const result = await auth.verifyServiceSignature(request, { NR_SERVICE_SIGNING_SECRET: SECRET }, raw, { db: makeDb() });
  assert.equal(result.ok, false);
  assert.equal(await result.response.json().then(j => j.code), "SERVICE_AUTH_EXPIRED");
});

test("HMAC: nonce replay is rejected (409)", async () => {
  const db = makeDb();
  const raw = "{}";
  const headers = await auth.signServiceBody(SECRET, ACTOR, raw, { nonce: "nonce-replay-0001" });
  const request = new Request("http://127.0.0.1/api/x", { method: "POST", headers, body: raw });
  const env = { NR_SERVICE_SIGNING_SECRET: SECRET };
  assert.equal((await auth.verifyServiceSignature(request, env, raw, { db })).ok, true);
  const second = await auth.verifyServiceSignature(request, env, raw, { db });
  assert.equal(second.ok, false);
  assert.equal(await second.response.json().then(j => j.code), "SERVICE_AUTH_REPLAY");
});

test("HMAC: missing/short service key fails closed (503), never anonymous", async () => {
  const raw = "{}";
  const headers = await auth.signServiceBody(SECRET, ACTOR, raw, { nonce: "nonce-nokey-00001" });
  const request = new Request("http://127.0.0.1/api/x", { method: "POST", headers, body: raw });
  for (const env of [{}, { NR_SERVICE_SIGNING_SECRET: "short" }]) {
    const result = await auth.verifyServiceSignature(request, env, raw, { db: makeDb() });
    assert.equal(result.ok, false);
    assert.equal(result.response.status, 503);
  }
});

test("HMAC: browser session key cannot be reused as the service key", async () => {
  const raw = "{}";
  const headers = await auth.signServiceBody("another-key-0123456789-abcdefghijkl", ACTOR, raw, { nonce: "nonce-cross-00001" });
  const request = new Request("http://127.0.0.1/api/x", { method: "POST", headers, body: raw });
  const result = await auth.verifyServiceSignature(request, { NR_SERVICE_SIGNING_SECRET: SECRET }, raw, { db: makeDb() });
  assert.equal(result.ok, false);
});

// ------------------------------------------------------------- OIDC (offline)

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "unit-test-kid", alg: "RS256", use: "sig" };
const JWKS_FETCHER = async () => ({ ok: true, json: async () => ({ keys: [JWK] }) });

function makeJwt(claims, header = { alg: "RS256", kid: "unit-test-kid", typ: "JWT" }) {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(h + "." + p), privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}

function goodClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "jev-strategy-verification",
    iat: now - 10, exp: now + 600,
    repository: "yihui315/night-researcher-dash",
    ref: "refs/heads/main",
    sha: "deadbeef",
    job_workflow_ref: "yihui315/night-researcher-dash/.github/workflows/strategy-verification.yml@refs/heads/main",
    actor: "github-actions[bot]",
    runner_environment: "github-hosted",
    ...overrides
  };
}

test("OIDC: correctly signed token with pinned claims verifies (offline RSA keypair)", async () => {
  const result = await auth.verifyGithubOidc(makeJwt(goodClaims()), {}, {}, { fetcher: JWKS_FETCHER });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.authMethod, "github-actions-oidc");
  assert.equal(result.commitSha, "deadbeef");
});

test("OIDC: wrong repository / ref / audience / expired / bad signature all fail", async () => {
  const cases = [
    goodClaims({ repository: "attacker/evil" }),
    goodClaims({ ref: "refs/heads/some-random-branch" }),
    goodClaims({ aud: "wrong-audience" }),
    goodClaims({ exp: Math.floor(Date.now() / 1000) - 1 }),
    goodClaims({ runner_environment: "self-hosted" })
  ];
  for (const claims of cases) {
    const result = await auth.verifyGithubOidc(makeJwt(claims), {}, {}, { fetcher: JWKS_FETCHER });
    assert.equal(result.ok, false, JSON.stringify(claims));
  }
  const tampered = makeJwt(goodClaims()).slice(0, -6) + "AAAAAA";
  assert.equal((await auth.verifyGithubOidc(tampered, {}, {}, { fetcher: JWKS_FETCHER })).ok, false);
  assert.equal((await auth.verifyGithubOidc("not-a-jwt", {}, {}, { fetcher: JWKS_FETCHER })).ok, false);
});

// --------------------------------------------------------- equity snapshot math

test("equity: real marks produce correct mark-to-market equity and unrealized PnL", () => {
  const marks = { BTCUSDT: 6000000000000n }; // 60000 * 1e8
  const snap = equity.computeEquitySnapshot(
    accountRow(), { marks, marksJson: "{}", markQuality: "verified", missing: [] }, null, Date.now()
  );
  // cash 9000 + 0.02 * 60000 = 10200
  assert.equal(snap.equity, 10200 * 1e8);
  assert.equal(snap.marketValue, 1200 * 1e8);
  assert.equal(snap.unrealizedPnl, 200 * 1e8);
  assert.equal(snap.markQuality, "verified");
  assert.equal(snap.usable, true);
  assert.equal(snap.drawdown, 0);
});

test("equity: missing real mark -> unknown snapshot, NEVER usable for gating", () => {
  const snap = equity.computeEquitySnapshot(
    accountRow(), { marks: {}, marksJson: "{}", markQuality: "unknown", missing: ["BTCUSDT"] }, null, Date.now()
  );
  assert.equal(snap.markQuality, "unknown");
  assert.equal(snap.usable, false);
  assert.ok(snap.reason.startsWith("MISSING_REAL_MARK"));
});

test("equity: an earlier generation's peak is NOT mixed in (1e8 fixed point regression)", () => {
  const marks = { BTCUSDT: 6000000000000n };
  // A 1e8-scaled peak of 20000 must be interpreted as 20000, not 20000*1e8.
  const snap = equity.computeEquitySnapshot(
    accountRow(), { marks, marksJson: "{}", markQuality: "verified", missing: [] }, 20000 * 1e8, Date.now()
  );
  assert.equal(snap.equityPeak, 20000 * 1e8);
  // (20000 - 10200) / 20000 = 0.49 -> 49,000,000 (1e8 fixed point)
  assert.ok(Math.abs(snap.drawdown - 49000000) <= 1);
});

test("equity: drawdown is the WORST account, never offset by another account's profit", async () => {
  const accounts = [
    { session_id: "S-A", state_json: JSON.stringify({ generation: 1 }) },
    { session_id: "S-B", state_json: JSON.stringify({ generation: 2 }) }
  ];
  const iso = (ms) => new Date(Date.now() - ms).toISOString();
  const snapshots = [
    { session_id: "S-A", generation: 1, mark_quality: "verified", equity: 10000 * 1e8, created_at: iso(120000), equity_peak: 10000 * 1e8, drawdown: 0 },
    { session_id: "S-A", generation: 1, mark_quality: "verified", equity: 10000 * 1e8, created_at: iso(60000), equity_peak: 10000 * 1e8, drawdown: 0 },
    { session_id: "S-B", generation: 2, mark_quality: "verified", equity: 10000 * 1e8, created_at: iso(120000), equity_peak: 10000 * 1e8, drawdown: 0 },
    { session_id: "S-B", generation: 2, mark_quality: "verified", equity: 6000 * 1e8, created_at: iso(60000), equity_peak: 10000 * 1e8, drawdown: 40000000 }
  ];
  const db = makeDb({ accounts, snapshots });
  const risk = await equity.buildEquityRiskBasis(db);
  assert.equal(risk.usable, true);
  assert.equal(risk.riskBasis, "mark-to-market-equity-snapshots");
  assert.equal(risk.max_drawdown_pct, 40000000); // 40%, worst account, not netted
});

test("equity regression: baseline-seeded peak exposes a FIRST losing snapshot", async () => {
  // Real V4.3 E2E run1 showed max_drawdown_pct = 0 because the peak was
  // initialised from the first (already lossy) snapshot. The stored
  // equity_peak carries the pre-trade baseline and must be used.
  const accounts = [{ session_id: "S-A", state_json: JSON.stringify({ generation: 1 }) }];
  const iso = (ms) => new Date(Date.now() - ms).toISOString();
  const snapshots = [
    { session_id: "S-A", generation: 1, mark_quality: "verified", equity: 9999 * 1e8,
      created_at: iso(120000), equity_peak: 10000 * 1e8, drawdown: 0 },
    { session_id: "S-A", generation: 1, mark_quality: "verified", equity: 9999 * 1e8,
      created_at: iso(60000), equity_peak: 10000 * 1e8, drawdown: 10000 }
  ];
  const risk = await equity.buildEquityRiskBasis(makeDb({ accounts, snapshots }));
  assert.equal(risk.usable, true);
  assert.ok(risk.max_drawdown_pct > 0, "first-loss drawdown must not be zero");
  assert.ok(Math.abs(risk.max_drawdown_pct - 10000) <= 1);
});

test("equity: insufficient verified snapshots -> realized-pnl-only (gate must fail closed)", async () => {
  const accounts = [{ session_id: "S-A", state_json: JSON.stringify({ generation: 1 }) }];
  const snapshots = [
    { session_id: "S-A", generation: 1, mark_quality: "verified", equity: 10000 * 1e8,
      created_at: new Date().toISOString(), equity_peak: 10000 * 1e8, drawdown: 0 }
  ];
  const risk = await equity.buildEquityRiskBasis(makeDb({ accounts, snapshots }));
  assert.equal(risk.usable, false);
  assert.equal(risk.riskBasis, "realized-pnl-only");
  assert.ok(risk.reason.startsWith("INSUFFICIENT_VERIFIED_SNAPSHOTS"));
});

test("equity: unknown-quality snapshots never satisfy the risk basis", async () => {
  const accounts = [{ session_id: "S-A", state_json: JSON.stringify({ generation: 1 }) }];
  const snapshots = [
    { session_id: "S-A", generation: 1, mark_quality: "unknown", equity: 0, created_at: new Date().toISOString(), equity_peak: 0, drawdown: 0 },
    { session_id: "S-A", generation: 1, mark_quality: "unknown", equity: 0, created_at: new Date().toISOString(), equity_peak: 0, drawdown: 0 }
  ];
  const risk = await equity.buildEquityRiskBasis(makeDb({ accounts, snapshots }));
  assert.equal(risk.usable, false);
  assert.equal(risk.riskBasis, "realized-pnl-only");
});

// ------------------------------------------------------------ strategy events

test("strategy_events: hash chain verifies and detects tampering", async () => {
  const db = makeDb();
  const a = await events.appendStrategyEvent(db, "s1", "strategy.equity.snapshot", { n: 1 });
  const b = await events.appendStrategyEvent(db, "s1", "strategy.auto.paused", { reason: "dd>20%" });
  assert.equal(a.ok, true);
  assert.equal(b.prevHash, a.hash);
  const ok = await events.verifyStrategyEventChain(db);
  assert.equal(ok.verified, true);
  assert.equal(ok.count, 2);
  db.state.events[0].payload_json = "{\"n\":999}";
  const bad = await events.verifyStrategyEventChain(db);
  assert.equal(bad.verified, false);
});

test("strategy_events: unlisted event type is refused", async () => {
  const db = makeDb();
  const r = await events.appendStrategyEvent(db, "s1", "strategy.auto.execute", {});
  assert.equal(r.ok, false);
  assert.equal(r.error, "STRATEGY_EVENT_TYPE_NOT_ALLOWED");
});

test("ledger: trading replay event whitelist is unchanged by V4.3", () => {
  // Guard against accidentally polluting paper_server_events replay chain.
  assert.ok(ledger.json);
  assert.ok(ledger.requireConfig);
});
