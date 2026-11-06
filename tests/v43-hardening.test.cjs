/**
 * V4.3 security hardening - INDEPENDENT tests.
 *
 * Covers the two trust-boundary gaps reported in the PHASE 4 Step 2 review:
 *   A. OIDC workflow identity must be pinned by the SERVER, never by the
 *      client-controlled bundle provenance; six-role research rejects OIDC.
 *   B. engine_sha256 must be compared to a server-approved engine version.
 *
 * These tests ADD coverage. No original assertion in any existing test file
 * is modified, removed, relaxed, or re-labelled.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");

const WORKFLOW = "yihui315/night-researcher-dash/.github/workflows/strategy-verification.yml@refs/heads/main";
const OTHER_WORKFLOW = "yihui315/night-researcher-dash/.github/workflows/quality.yml@refs/heads/main";
const ENGINE = "a".repeat(64);
const OTHER_ENGINE = "b".repeat(64);

let anchorsLib, verification, auth, route, runsRoute;

test.before(async () => {
  anchorsLib = await import("../functions/_lib/trust-anchors.mjs");
  verification = await import("../functions/_lib/verification.mjs");
  auth = await import("../functions/_lib/service-auth.mjs");
  route = await import("../functions/api/agents/research.js");
  runsRoute = await import("../functions/api/verification/runs.js");
});

const GOOD_ENV = {
  NR_OIDC_ALLOWED_WORKFLOW_REF: WORKFLOW,
  NR_APPROVED_ENGINE_SHA256: ENGINE,
};

// ---------------------------------------------------------------- A: anchors

test("H-A1 missing server anchors -> fail closed, no trust possible", () => {
  for (const env of [{}, { NR_OIDC_ALLOWED_WORKFLOW_REF: WORKFLOW },
                     { NR_APPROVED_ENGINE_SHA256: ENGINE }]) {
    const a = anchorsLib.readTrustAnchors(env);
    assert.equal(a.ok, false, JSON.stringify(env));
    assert.equal(anchorsLib.workflowAllowed(WORKFLOW, a), false);
    assert.equal(anchorsLib.engineApproved(ENGINE, a), false);
  }
});

test("H-A2 malformed anchors are rejected (not silently accepted)", () => {
  const cases = [
    { NR_OIDC_ALLOWED_WORKFLOW_REF: "not-a-workflow-ref", NR_APPROVED_ENGINE_SHA256: ENGINE },
    { NR_OIDC_ALLOWED_WORKFLOW_REF: WORKFLOW, NR_APPROVED_ENGINE_SHA256: "XYZ" },
    { NR_OIDC_ALLOWED_WORKFLOW_REF: WORKFLOW, NR_APPROVED_ENGINE_SHA256: "g".repeat(64) },
    { NR_OIDC_ALLOWED_WORKFLOW_REF: WORKFLOW, NR_APPROVED_ENGINE_SHA256: "a".repeat(63) },
  ];
  for (const env of cases) {
    const a = anchorsLib.readTrustAnchors(env);
    assert.equal(a.ok, false, JSON.stringify(env));
    assert.ok(a.errors.length >= 1);
  }
});

test("H-A3 valid anchors allow ONLY the exact workflow and exact engine", () => {
  const a = anchorsLib.readTrustAnchors(GOOD_ENV);
  assert.equal(a.ok, true, JSON.stringify(a.errors));
  assert.equal(anchorsLib.workflowAllowed(WORKFLOW, a), true);
  assert.equal(anchorsLib.workflowAllowed(OTHER_WORKFLOW, a), false);
  assert.equal(anchorsLib.workflowAllowed(WORKFLOW + " ", a), false);
  assert.equal(anchorsLib.engineApproved(ENGINE, a), true);
  assert.equal(anchorsLib.engineApproved(ENGINE.toUpperCase(), a), true);
  assert.equal(anchorsLib.engineApproved(OTHER_ENGINE, a), false);
  assert.equal(anchorsLib.engineApproved("", a), false);
});

test("H-A4 client-supplied provenance.workflow_ref can NEVER become the anchor", () => {
  const a = anchorsLib.readTrustAnchors(GOOD_ENV);
  const expected = anchorsLib.serverExpectedClaims(
    GOOD_ENV, a, { workflow_ref: OTHER_WORKFLOW, repository: "attacker/evil",
                   git_commit_sha: "deadbeef" });
  assert.equal(expected.workflowRef, WORKFLOW);
  assert.notEqual(expected.workflowRef, OTHER_WORKFLOW);
  assert.equal(expected.commitSha, "deadbeef");
  assert.equal(expected.repository, undefined, "repository must come from env, not bundle");
});

// ---------------------------------------------------- A: OIDC function layer

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const JWKS_FETCHER = async () => ({ ok: true, json: async () => ({ keys: [{ ...jwk, kid: "hardening-kid" }] }) });

function makeJwt(claims) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "hardening-kid", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(h + "." + p), privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}
function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "jev-strategy-verification", iat: now - 10, exp: now + 600,
    repository: "yihui315/night-researcher-dash", ref: "refs/heads/main",
    sha: "deadbeef", job_workflow_ref: WORKFLOW,
    actor: "github-actions[bot]", runner_environment: "github-hosted",
    ...overrides
  };
}

test("H-A5 correctly signed OIDC token from a NON-approved workflow is rejected", async () => {
  const token = makeJwt(claims({ job_workflow_ref: OTHER_WORKFLOW }));
  const r = await auth.verifyGithubOidc(token, GOOD_ENV, {}, { fetcher: JWKS_FETCHER });
  assert.equal(r.ok, false);
  assert.equal(r.error, "OIDC_WORKFLOW_NOT_ALLOWED");
});

test("H-A6 approved workflow still verifies (hardening does not break the real runner)", async () => {
  const token = makeJwt(claims());
  const r = await auth.verifyGithubOidc(token, GOOD_ENV, {}, { fetcher: JWKS_FETCHER });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.workflowRef, WORKFLOW);
});

test("H-A7 a client 'expected.workflowRef' cannot override the server allowlist", async () => {
  const token = makeJwt(claims({ job_workflow_ref: OTHER_WORKFLOW }));
  const r = await auth.verifyGithubOidc(token, GOOD_ENV,
    { workflowRef: OTHER_WORKFLOW }, { fetcher: JWKS_FETCHER });
  assert.equal(r.ok, false);
  assert.equal(r.error, "OIDC_WORKFLOW_NOT_ALLOWED");
});

// ------------------------------------------------------------- B: engine SHA

function goodCore(overrides = {}) {
  return {
    schema: verification.SCHEMA,
    provenance: {
      repository: "yihui315/night-researcher-dash",
      engine_sha256: ENGINE,
      strategy_source_sha256: "c".repeat(64),
      runner_source_sha256: "d".repeat(64),
      generated_at: new Date().toISOString(),
      engine_mode: "real-python-backtest-engine",
      runner: "github-actions",
      git_commit_sha: "e".repeat(40),
      workflow_ref: WORKFLOW,
      ...(overrides.provenance || {})
    },
    runs: [{
      run_id: "hardening-run-0001",
      python_strategy_id: "FNG_EMA_MR",
      strategy_id: "fng_ema_mean_reversion",
      strategy_version: "v1",
      symbol: "BTCUSDT",
      window_from: "2025-01-01T00:00:00.000Z",
      window_to: "2025-04-01T00:00:00.000Z",
      input_sha256: "f".repeat(64),
      folds: 3,
      data_sources: ["binance"],
      walk_forward: [{ status: "VALIDATED" }, { status: "VALIDATED" }, { status: "VALIDATED" }],
      metrics: {
        sample_count: 200, oos_trades: 40, max_drawdown: 0.1,
        insample: { win_rate: 0.5, net: 1 }, oos: { win_rate: 0.5, net: 1 }
      },
      gates: { strategy_pass: 1, oos_pass: 1, overfit_suspect: 0 }
    }],
    ...(overrides.core || {})
  };
}
const VERSION = { strategy_id: "fng_ema_mean_reversion", version: "v1",
                  source_sha256: "c".repeat(64), frozen: 1 };
const OIDC_ID = { authMethod: "github-actions-oidc", trusted: 1, workflowRef: WORKFLOW };

test("H-B1 unapproved engine hash -> verified=0 / trusted=0 even for a valid OIDC runner", () => {
  const a = anchorsLib.readTrustAnchors(GOOD_ENV);
  const core = goodCore({ provenance: { engine_sha256: OTHER_ENGINE } });
  const d = verification.decideEvidence(core.runs[0], core, OIDC_ID, VERSION, true, a);
  assert.equal(d.verified, 0);
  assert.equal(d.trusted, 0);
  assert.equal(d.checks.engineApproved, false);
  assert.ok(d.reasons.includes("engineApproved"));
});

test("H-B2 approved engine + approved workflow -> verified=1 / trusted=1", () => {
  const a = anchorsLib.readTrustAnchors(GOOD_ENV);
  const core = goodCore();
  const d = verification.decideEvidence(core.runs[0], core, OIDC_ID, VERSION, true, a);
  assert.equal(d.verified, 1, JSON.stringify(d.reasons));
  assert.equal(d.trusted, 1);
});

test("H-B3 OIDC identity from a non-approved workflow -> trusted=0", () => {
  const a = anchorsLib.readTrustAnchors(GOOD_ENV);
  const core = goodCore();
  const bad = { authMethod: "github-actions-oidc", trusted: 1, workflowRef: OTHER_WORKFLOW };
  const d = verification.decideEvidence(core.runs[0], core, bad, VERSION, true, a);
  assert.equal(d.verified, 1, "data integrity is independent of the workflow pin");
  assert.equal(d.trusted, 0, "but the release trust anchor must be withheld");
});

test("H-B4 HMAC service identity can NEVER become trusted even with valid anchors", () => {
  const a = anchorsLib.readTrustAnchors(GOOD_ENV);
  const core = goodCore();
  const hmac = { authMethod: "hmac-service", trusted: 0, workflowRef: WORKFLOW };
  const d = verification.decideEvidence(core.runs[0], core, hmac, VERSION, true, a);
  assert.equal(d.verified, 1, "local E2E may still exercise verified=1 writes");
  assert.equal(d.trusted, 0);
});

test("H-B5 original pure-function contract (no anchors arg) is unchanged", () => {
  const core = goodCore();
  const d = verification.decideEvidence(core.runs[0], core, OIDC_ID, VERSION, true);
  assert.equal(d.verified, 1);
  assert.equal(d.trusted, 1);
  assert.equal(d.checks.engineApproved, undefined, "no new check when anchors are omitted");
});

// ------------------------------------------------------- route-level gates

function mockDb() {
  return { prepare() { return { bind() { return this; }, async first() { return null; },
                                async all() { return { results: [] }; },
                                async run() { return { success: true }; } }; },
           async batch() { return []; } };
}
function routeEnv(overrides = {}) {
  return { PAPER_DB: mockDb(),
           PAPER_LEDGER_SECRET: "test-paper-ledger-secret-0123456789-abcdefgh",
           NR_SERVICE_SIGNING_SECRET: "test-service-signing-secret-0123456789-abcdefgh",
           ...overrides };
}
function makeOidcRequest() {
  return new Request("https://night-researcher.test/api/agents/research", {
    method: "POST", headers: { "content-type": "application/json",
                               "X-GitHub-OIDC-Token": "eyJhbGciOiJSUzI1NiJ9.fake.sig" },
    body: "{}"
  });
}

test("H-A8 six-role research explicitly rejects ANY OIDC identity", async () => {
  const r = await route.handleResearchRequest(makeOidcRequest(), routeEnv(), async () => {
    throw new Error("handler must never be reached");
  });
  assert.equal(r.status, 401);
  const b = await r.json();
  assert.equal(b.code, "SIX_ROLE_OIDC_IDENTITY_REJECTED");
});

test("H-A9 trusted verification route refuses to run without server anchors", async () => {
  const req = new Request("https://night-researcher.test/api/verification/runs", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  const r = await runsRoute.onRequest({ request: req, env: routeEnv() });
  assert.equal(r.status, 503);
  const b = await r.json();
  assert.equal(b.code, "TRUST_ANCHORS_NOT_CONFIGURED");
  assert.ok(b.errors.includes("NR_OIDC_ALLOWED_WORKFLOW_REF_NOT_CONFIGURED"));
  assert.ok(b.errors.includes("NR_APPROVED_ENGINE_SHA256_NOT_CONFIGURED"));
});
