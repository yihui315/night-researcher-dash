/**
 * JEV V4.3 / §2 - OFFLINE unit tests for the trusted verification core.
 * These prove the VALIDATION logic; real D1 atomic persistence + real bundle
 * from the Python engine are covered by v43_e2e against wrangler --local.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

let lib;
test.before(async () => {
  lib = await import("../functions/_lib/verification.mjs");
});

const HEX = "a".repeat(64);
const SHA1 = "b".repeat(40);
const OIDC = {
  authMethod: "github-actions-oidc", trusted: 1,
  repository: "yihui315/night-researcher-dash",
  commitSha: SHA1,
  workflowRef: "yihui315/night-researcher-dash/.github/workflows/strategy-verification.yml@refs/heads/main",
  actor: "github-actions[bot]"
};
const HMAC = { authMethod: "hmac-service", trusted: 0, actor: "local-e2e" };

function goodCore(overrides = {}) {
  const run = {
    run_id: "run-unit-0001",
    strategy_id: "fng_ema_mean_reversion",
    python_strategy_id: "FNG_EMA_MR",
    strategy_version: "v1",
    symbol: "BTCUSDT",
    interval: "4h",
    window_from: "2024-11-01T00:00:00.000Z",
    window_to: "2026-11-01T00:00:00.000Z",
    data_sources: ["binance-public-klines", "alternative-me-fng"],
    input_sha256: HEX,
    folds: 3,
    metrics: {
      sample_count: 150, oos_trades: 40, max_drawdown: 0.08,
      insample: { n: 100, net: 0.25, win_rate: 0.6, avg_win: 0.03, avg_loss: -0.02, profit_factor: 1.8 },
      oos: { n: 50, net: 0.09, win_rate: 0.55, profit_factor: 1.4 }
    },
    gates: { strategy_pass: 1, oos_pass: 1, overfit_suspect: 0, reasons: [] },
    walk_forward: [
      { fold: 1, status: "VALIDATED", n: 14 },
      { fold: 2, status: "VALIDATED", n: 13 },
      { fold: 3, status: "VALIDATED", n: 13 }
    ],
    grid: { overfit_flag: false },
    ...(overrides.run || {})
  };
  return {
    schema: lib.SCHEMA,
    provenance: {
      repository: OIDC.repository,
      git_commit_sha: SHA1,
      git_ref: "refs/heads/main",
      workflow_run_id: "42000000000",
      workflow_name: "Strategy Verification",
      workflow_ref: OIDC.workflowRef,
      runner: "github-actions",
      engine_sha256: HEX,
      strategy_source_sha256: HEX,
      runner_source_sha256: HEX,
      engine_mode: "real-python-backtest-engine",
      generated_at: "2026-11-06T00:00:00.000Z",
      ...(overrides.provenance || {})
    },
    runs: [run]
  };
}

function sealed(core) {
  // The server hashes the exact canonical_payload bytes; ordering is the
  // producer's responsibility. A plain stringify is enough for these fixtures
  // (do NOT pass a key array as JSON.stringify's replacer - it silently drops
  // nested fields, which broke the tamper test).
  const payload = JSON.stringify(core);
  const sha = createHash("sha256").update(payload, "utf8").digest("hex");
  return { ...core, canonical_payload: payload, bundle_sha256: sha };
}

test("seal: valid canonical payload is accepted and becomes authoritative", async () => {
  const core = goodCore();
  const r = await lib.parseAndSealBundle(sealed(core));
  assert.equal(r.ok, true, r.errors.join(","));
  assert.equal(r.core.runs.length, 1);
});

test("seal: tampered canonical payload / wrong sha / missing seal all fail closed", async () => {
  const core = goodCore();
  const good = sealed(core);
  const tampered = { ...good, canonical_payload: good.canonical_payload.replace("150", "999") };
  assert.ok((await lib.parseAndSealBundle(tampered)).errors.includes("BUNDLE_SHA256_MISMATCH"));
  assert.ok((await lib.parseAndSealBundle({ ...good, bundle_sha256: HEX })).errors.includes("BUNDLE_SHA256_MISMATCH"));
  assert.ok((await lib.parseAndSealBundle({ ...good, canonical_payload: "" })).errors.includes("CANONICAL_PAYLOAD_MISSING"));
  assert.ok((await lib.parseAndSealBundle({ ...good, runs: [] })).errors.includes("BUNDLE_OUTER_FIELDS_MISMATCH"));
});

test("validate: a fully pinned real bundle passes with OIDC identity", () => {
  const r = lib.validateBundle(goodCore(), OIDC);
  assert.equal(r.ok, true, r.errors.join(","));
});

test("validate: client cannot self-report a passing gate contradicted by metrics", () => {
  const cases = [
    goodCore({ run: { metrics: { sample_count: 12, oos_trades: 40, max_drawdown: 0.08,
      insample: { net: 0.2, win_rate: 0.6 }, oos: { net: 0.1, win_rate: 0.5 } },
      gates: { strategy_pass: 1, oos_pass: 1, overfit_suspect: 0 } } }),
    goodCore({ run: { metrics: { sample_count: 150, oos_trades: 3, max_drawdown: 0.08,
      insample: { net: 0.2, win_rate: 0.6 }, oos: { net: 0.1, win_rate: 0.5 } },
      gates: { strategy_pass: 1, oos_pass: 1, overfit_suspect: 0 } } }),
    goodCore({ run: { gates: { strategy_pass: 1, oos_pass: 1, overfit_suspect: 1 } } })
  ];
  for (const core of cases) {
    const r = lib.validateBundle(core, OIDC);
    assert.equal(r.ok, false, JSON.stringify(core.runs[0].gates));
    assert.ok(r.errors.some(e => e.includes("CONTRADICTS_METRICS")));
  }
});

test("validate: OIDC identity is pinned to repository / commit / workflow / runner", () => {
  const cases = [
    goodCore({ provenance: { repository: "attacker/evil" } }),
    goodCore({ provenance: { git_commit_sha: "c".repeat(40) } }),
    goodCore({ provenance: { workflow_ref: "wrong/workflow.yml@refs/heads/main" } }),
    goodCore({ provenance: { runner: "local" } })
  ];
  for (const core of cases) {
    assert.equal(lib.validateBundle(core, OIDC).ok, false);
  }
});

test("validate: missing inputs, unknown strategy mapping and wrong fold count fail", () => {
  assert.ok(lib.validateBundle(goodCore({ run: { input_sha256: "nope" } }), OIDC).errors.some(e => e.includes("INPUT_HASH_INVALID")));
  assert.ok(lib.validateBundle(goodCore({ run: { python_strategy_id: "EVIL" } }), OIDC).errors.some(e => e.includes("STRATEGY_ID_MAPPING_MISMATCH")));
  assert.ok(lib.validateBundle(goodCore({ run: { folds: 2 } }), OIDC).errors.some(e => e.includes("FOLDS_INVALID")));
  assert.ok(lib.validateBundle({ schema: "wrong", provenance: {}, runs: [] }, OIDC).errors.includes("SCHEMA_MISMATCH"));
});

test("decideEvidence: only a real OIDC runner yields trusted=1", () => {
  const core = goodCore();
  const run = core.runs[0];
  const version = { strategy_id: run.strategy_id, version: "v1", source_sha256: HEX, frozen: 1 };
  const oidc = lib.decideEvidence(run, core, OIDC, version, true);
  assert.equal(oidc.verified, 1);
  assert.equal(oidc.trusted, 1);
  assert.equal(oidc.status, "verified");

  const hmac = lib.decideEvidence(run, core, HMAC, version, true);
  assert.equal(hmac.verified, 1, "local E2E may exercise verified=1 write path");
  assert.equal(hmac.trusted, 0, "but must NEVER become a release trust anchor");
});

test("decideEvidence: unfrozen / hash-mismatched / missing version blocks verified", () => {
  const core = goodCore();
  const run = core.runs[0];
  for (const version of [
    null,
    { strategy_id: run.strategy_id, version: "v1", source_sha256: HEX, frozen: 0 },
    { strategy_id: run.strategy_id, version: "v1", source_sha256: "f".repeat(64), frozen: 1 },
    { strategy_id: run.strategy_id, version: "v9", source_sha256: HEX, frozen: 1 }
  ]) {
    const d = lib.decideEvidence(run, core, OIDC, version, true);
    assert.equal(d.verified, 0);
  }
  assert.equal(lib.decideEvidence(run, core, OIDC,
    { strategy_id: run.strategy_id, version: "v1", source_sha256: HEX, frozen: 1 }, false).verified, 0);
});
