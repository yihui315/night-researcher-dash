/**
 * JEV V4.3 / §4 - /api/agents/research authentication hardening.
 * OFFLINE route-level tests. Real six-role inference stays BLOCKED until the
 * JEV Provider Center bridge is connected and real credentials are supplied.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

let route, auth;
test.before(async () => {
  route = await import("../functions/api/agents/research.js");
  auth = await import("../functions/_lib/service-auth.mjs");
});

const SECRET = "test-service-signing-secret-0123456789-abcdefgh";
const LEDGER_SECRET = "test-paper-ledger-secret-0123456789-abcdefgh";
const ACTOR = "jev-provider-bridge";

function makeDb() {
  const state = { nonces: {}, events: [] };
  const binding = (sql, args) => ({
    bind(...newArgs) { return binding(sql, newArgs); },
    async first() {
      if (sql.includes("FROM verification_nonces")) {
        const n = state.nonces[args[0]];
        return n ? { actor: n.actor, created_at: n.created_at } : null;
      }
      if (sql.includes("FROM strategy_events") && sql.includes("ORDER BY seq DESC")) {
        return state.events.length ? state.events[state.events.length - 1] : null;
      }
      return null;
    },
    async all() { return { results: [] }; },
    async run() {
      if (sql.includes("INSERT INTO verification_nonces") && !state.nonces[args[0]]) {
        state.nonces[args[0]] = { actor: args[1], created_at: args[2] };
      }
      if (sql.includes("INSERT INTO strategy_events")) {
        state.events.push({ hash: args[4], prev_hash: args[3] });
      }
      return { success: true };
    }
  });
  return { state, prepare(sql) { return binding(sql, []); }, async batch() { return []; } };
}

function env(db, overrides = {}) {
  return {
    PAPER_DB: db,
    PAPER_LEDGER_SECRET: LEDGER_SECRET,
    NR_SERVICE_SIGNING_SECRET: SECRET,
    ...overrides
  };
}

async function signedRequest(body, db, opts = {}) {
  const raw = JSON.stringify(body);
  const headers = await auth.signServiceBody(SECRET, ACTOR, raw, {
    nonce: opts.nonce || ("nonce-" + Math.random().toString(36).slice(2)),
    ...(opts.stale ? { timestamp: Math.floor(Date.now() / 1000) - 3600 } : {})
  });
  headers["content-type"] = "application/json";
  if (opts.origin !== null) headers["origin"] = opts.origin || "https://night-researcher.test";
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return { request: new Request("https://night-researcher.test/api/agents/research",
                                { method: "POST", headers, body: raw }), raw, headers };
}

const GOOD_BODY = {
  provider: "minimax", model: "MiniMax-M3", runId: "2f1b0000-0000-4000-8000-000000000001",
  snapshot: { symbol: "BTCUSDT", price: 75400.15 },
  serviceCredentials: { apiKey: "server-side-only-key-123456", region: "china", workspaceId: "ws-1" }
};

function mockHandler(capture) {
  return async (request, _ai, _env, trustContext) => {
    capture.body = await request.clone().json();
    capture.trustContext = trustContext;
    capture.requestText = await request.clone().text();
    return new Response(JSON.stringify({ ok: true, runId: GOOD_BODY.runId,
                                        snapshotHash: "abc", autoExecution: false }),
                        { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("research: no service signature is rejected even WITH a valid Origin and cookie", async () => {
  const db = makeDb();
  const request = new Request("https://night-researcher.test/api/agents/research", {
    method: "POST",
    headers: { "content-type": "application/json", "origin": "https://night-researcher.test",
               "cookie": "nr_paper_session=fake" },
    body: JSON.stringify(GOOD_BODY)
  });
  const res = await route.handleResearchRequest(request, env(db), mockHandler({}));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "SERVICE_AUTH_MALFORMED");
});

test("research: missing Origin no longer bypasses authentication", async () => {
  const db = makeDb();
  const request = new Request("https://night-researcher.test/api/agents/research", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(GOOD_BODY)
  });
  const res = await route.handleResearchRequest(request, env(db), mockHandler({}));
  assert.equal(res.status, 401);
});

test("research: browser-submitted apiKey / region / workspaceId are rejected", async () => {
  for (const field of ["apiKey", "api_key", "region", "workspaceId", "token"]) {
    const db = makeDb();
    const body = { ...GOOD_BODY, [field]: "browser-secret" };
    delete body.serviceCredentials;
    const { request } = await signedRequest(body, db);
    const res = await route.handleResearchRequest(request, env(db), mockHandler({}));
    assert.equal(res.status, 400, field);
    assert.equal((await res.json()).code, "BROWSER_CREDENTIALS_FORBIDDEN");
  }
});

test("research: signed request WITHOUT bridge credentials is explicitly BLOCKED", async () => {
  const db = makeDb();
  const body = { provider: "minimax", model: "MiniMax-M3", snapshot: { price: 1 } };
  const { request } = await signedRequest(body, db);
  const res = await route.handleResearchRequest(request, env(db), mockHandler({}));
  assert.equal(res.status, 503);
  const payload = await res.json();
  assert.equal(payload.code, "PROVIDER_BRIDGE_NOT_CONNECTED");
  assert.equal(payload.blocked, true);
});

test("research: signed bridge request injects credentials server-side and strips them from the body", async () => {
  const db = makeDb();
  const capture = {};
  const { request } = await signedRequest(GOOD_BODY, db);
  const res = await route.handleResearchRequest(request, env(db), mockHandler(capture));
  assert.equal(res.status, 200);
  assert.equal(capture.trustContext.snapshotSource, "signed-service-request");
  assert.equal(capture.trustContext.providerCredentials.apiKey, GOOD_BODY.serviceCredentials.apiKey);
  assert.equal(capture.trustContext.authMethod, "hmac-service");
  assert.equal(capture.body.apiKey, undefined);
  assert.equal(capture.body.serviceCredentials, undefined);
  assert.equal(capture.body.region, undefined);
  assert.ok(!capture.requestText.includes("server-side-only-key-123456"),
            "credential must never reach the orchestrator body");
  assert.ok(!(await res.text()).includes("server-side-only-key-123456"));
  assert.equal(db.state.events.length, 1, "trusted audit event written");
});

test("research: nonce replay of a signed bridge call is rejected", async () => {
  const db = makeDb();
  const { raw, headers } = await signedRequest(GOOD_BODY, db, { nonce: "nonce-research-replay" });
  const make = () => new Request("https://night-researcher.test/api/agents/research",
                                 { method: "POST", headers, body: raw });
  const first = await route.handleResearchRequest(make(), env(db), mockHandler({}));
  assert.equal(first.status, 200);
  const second = await route.handleResearchRequest(make(), env(db), mockHandler({}));
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, "SERVICE_AUTH_REPLAY");
});

test("research: missing service signing key fails closed (503)", async () => {
  const db = makeDb();
  const { request } = await signedRequest(GOOD_BODY, db);
  const res = await route.handleResearchRequest(request,
    env(db, { NR_SERVICE_SIGNING_SECRET: undefined }), mockHandler({}));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "SERVICE_AUTH_NOT_CONFIGURED");
});
