/**
 * JEV V4.2 PHASE 4 — pure deterministic gate / real-performance unit tests.
 * These are OFFLINE unit tests. They do NOT prove a real D1 integration;
 * that is covered separately by phase4_e2e against wrangler --local.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

let lib;
test.before(async () => {
  lib = await import("../functions/_lib/strategy-registry.mjs");
});

const VERSION = {
  strategy_id: "fng_ema_mean_reversion", lifecycle: "candidate", frozen: 1,
  source_sha256: "abc", version: "v1"
};
const GOOD_METRICS = {
  winRate: 0.6, avgWinPct: 0.03, avgLossPct: 0.02,
  profitFactor: 1.8, maxDrawdown: 0.08
};

const RUN_ID = "run-unit-0001";
const BUNDLE_SHA = "a".repeat(64);

/**
 * V4.3 contract extension: a passing offline fixture now needs THREE trust
 * anchors (verified rows + REAL mark-to-market equity evidence + a trusted
 * Runner receipt). No original assertion was removed; the fixture simply
 * supplies the now-required evidence, and new tests below assert that each
 * missing anchor fails closed.
 */
function verifiedEvidence(overrides = {}) {
  const runId = (overrides.backtest && overrides.backtest.run_id) || RUN_ID;
  return {
    version: { ...VERSION, ...(overrides.version || {}) },
    backtest: {
      run_id: RUN_ID,
      verified: 1, strategy_pass: 1, sample_count: 200,
      metrics_json: JSON.stringify(GOOD_METRICS),
      ...(overrides.backtest || {})
    },
    oos: { verified: 1, oos_pass: 1, oos_trades: 50, folds: 3, ...(overrides.oos || {}) },
    performance: overrides.performance === undefined
      ? {
          source: "real-d1-paper-fills",
          riskBasis: "mark-to-market-equity-snapshots",
          sessions: 1, max_drawdown_pct: lib.ratioToFp(0.05),
          equityEvidence: {
            usable: true, worstAccountWins: true, sessions: 1,
            snapshotCount: 3, max_drawdown_pct: lib.ratioToFp(0.05)
          }
        }
      : overrides.performance,
    receipt: overrides.receipt === undefined
      ? { run_id: runId, trusted: 1, auth_method: "github-actions-oidc", bundle_sha256: BUNDLE_SHA }
      : overrides.receipt
  };
}

test("no server-verified evidence -> NOT_ELIGIBLE and Kelly BLOCKED (fail closed)", () => {
  const d = lib.evaluateStrategyGate({ version: VERSION, backtest: null, oos: null, performance: null });
  assert.equal(d.eligible, false);
  assert.equal(d.status, "NOT_ELIGIBLE");
  assert.equal(d.autoExecution, false);
  assert.equal(d.kelly.status, "BLOCKED");
  assert.ok(d.reasons.join(" ").includes("verified=1"));
  assert.equal(d.evidence.backtestVerified, false);
  assert.equal(d.evidence.oosVerified, false);
});

test("static/unverified backtest and OOS must never be treated as a pass", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({
    backtest: { verified: 0, strategy_pass: 1, sample_count: 200, metrics_json: "{}" },
    oos: { verified: 0, oos_pass: 1, oos_trades: 50 }
  }));
  assert.equal(d.eligible, false);
  assert.equal(d.status, "NOT_ELIGIBLE");
  assert.ok(d.reasons.some(r => r.includes("复核通过")));
});

test("sample thresholds are enforced even when verified=1", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({
    backtest: { verified: 1, strategy_pass: 1, sample_count: 99, metrics_json: JSON.stringify(GOOD_METRICS) },
    oos: { verified: 1, oos_pass: 1, oos_trades: 29 }
  }));
  assert.equal(d.eligible, false);
  assert.ok(d.reasons.some(r => r.includes("100")));
  assert.ok(d.reasons.some(r => r.includes("30")));
});

test("real drawdown above 20% blocks release", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({
    performance: {
      source: "real-d1-paper-fills", riskBasis: "mark-to-market-equity-snapshots",
      sessions: 1, max_drawdown_pct: lib.ratioToFp(0.25),
      equityEvidence: { usable: true, worstAccountWins: true, sessions: 1,
                        snapshotCount: 3, max_drawdown_pct: lib.ratioToFp(0.25) }
    }
  }));
  assert.equal(d.eligible, false);
  assert.ok(d.reasons.some(r => r.includes("最大回撤")));
});

test("active strategy with failing evidence -> deterministic SUSPEND", () => {
  const d = lib.evaluateStrategyGate({
    version: { ...VERSION, lifecycle: "paper" }, backtest: null, oos: null, performance: null
  });
  assert.equal(d.status, "SUSPEND");
  assert.equal(d.autoExecution, false);
});

test("fully server-verified evidence -> ELIGIBLE with deterministic quarter-Kelly", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence());
  assert.equal(d.eligible, true);
  assert.equal(d.status, "ELIGIBLE");
  assert.equal(d.kelly.status, "READY");
  assert.equal(d.kelly.method, "quarter-kelly-wilson-lower-bound");
  assert.ok(d.kelly.allocationPct > 0 && d.kelly.allocationPct <= 0.10);
  assert.equal(d.autoExecution, false);
});

test("verified backtest/OOS still fail closed when real Paper performance is unavailable", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({ performance: null }));
  assert.equal(d.eligible, false);
  assert.equal(d.status, "NOT_ELIGIBLE");
  assert.equal(d.kelly.status, "BLOCKED");
  assert.equal(d.evidence.performanceAvailable, false);
  assert.ok(d.reasons.some(r => r.includes("权益快照")));
});

test("realized-PnL-only statistics cannot satisfy the account drawdown release gate", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({
    performance: { source: "real-d1-paper-fills", riskBasis: "realized-pnl-only", sessions: 1, max_drawdown_pct: 0 }
  }));
  assert.equal(d.eligible, false);
  assert.equal(d.kelly.status, "BLOCKED");
  assert.equal(d.evidence.performanceAvailable, false);
  assert.ok(d.reasons.some(r => r.includes("权益快照")));
});

test("performance from an unknown source cannot satisfy the release gate", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({
    performance: { source: "client-json", sessions: 1, max_drawdown_pct: 0 }
  }));
  assert.equal(d.eligible, false);
  assert.equal(d.kelly.status, "BLOCKED");
  assert.equal(d.evidence.performanceAvailable, false);
});

test("buildKellyMetrics only trusts verified rows and parses metrics_json", () => {
  const m = lib.buildKellyMetrics(
    { verified: 1, strategy_pass: 1, sample_count: 200, metrics_json: JSON.stringify(GOOD_METRICS) },
    { verified: 1, oos_pass: 1, oos_trades: 50 }
  );
  assert.equal(m.strategyPass, true);
  assert.equal(m.oosPass, true);
  assert.equal(m.winRate, 0.6);
  assert.equal(m.avgWinPct, 0.03);
  const bad = lib.buildKellyMetrics({ verified: 0, strategy_pass: 1, metrics_json: "{broken" }, null);
  assert.equal(bad.strategyPass, false);
  assert.equal(bad.oosPass, false);
  assert.equal(bad.winRate, 0);
});

test("fixed point conversion round-trip", () => {
  assert.equal(lib.fpToRatio(lib.ratioToFp(0.12345678)), 0.12345678);
  assert.equal(lib.ratioToFp(0.2), 20000000);
});

test("daily performance is computed only from real fill rows (1e8 fixed point)", () => {
  const rows = [
    { fill_id: "F1", session_id: "S1", created_at: "2026-11-04T01:00:00.000Z", realized_pnl: 10000000, fee: 1000000 },
    { fill_id: "F2", session_id: "S1", created_at: "2026-11-04T02:00:00.000Z", realized_pnl: -5000000, fee: 1000000 },
    { fill_id: "F3", session_id: "S2", created_at: "2026-11-05T01:00:00.000Z", realized_pnl: 20000000, fee: 2000000 }
  ];
  const perf = lib.computeDailyPerformance(rows, { S1: 10000, S2: 10000 });
  assert.equal(perf.source, "real-d1-paper-fills");
  assert.equal(perf.sampleFills, 3);
  assert.equal(perf.sessions, 2);
  assert.equal(perf.days.length, 2);
  assert.equal(perf.totals.trades, 3);
  assert.equal(perf.totals.wins, 2);
  assert.equal(perf.totals.gross_pnl, 25000000);
  assert.equal(perf.totals.fees, 4000000);
  assert.equal(perf.totals.net_pnl, 21000000);
  // 1e8 fixed point rounds 2/3 to 0.66666667; assert within one fixed-point unit.
  assert.ok(Math.abs(lib.fpToRatio(perf.win_rate) - 2 / 3) < 1 / lib.SCALE);
  assert.ok(perf.max_drawdown_pct > 0 && perf.max_drawdown_pct < lib.ratioToFp(0.01));
  assert.equal(lib.computeDailyPerformance([], {}).sampleFills, 0);
});

test("daily drawdown retains the intraday peak-to-trough maximum after recovery", () => {
  const rows = [
    { fill_id: "F1", session_id: "S1", created_at: "2026-11-05T01:00:00.000Z", realized_pnl: -1000000000, fee: 0 },
    { fill_id: "F2", session_id: "S1", created_at: "2026-11-05T02:00:00.000Z", realized_pnl: 1000000000, fee: 0 }
  ];
  const perf = lib.computeDailyPerformance(rows, { S1: 10000 });
  assert.equal(perf.days.length, 1);
  assert.equal(perf.days[0].max_drawdown_pct, lib.ratioToFp(0.001));
  assert.equal(perf.max_drawdown_pct, lib.ratioToFp(0.001));
});

test("performance window excludes pre-reset fills and carries pre-window PnL into baseline", () => {
  const accounts = [{
    session_id: "S1",
    created_at: "2026-11-01T00:00:00.000Z",
    state_json: JSON.stringify({ initialCash: 10000, generation: 2 })
  }];
  const resets = [{ session_id: "S1", reset_at: "2026-11-04T00:00:00.000Z" }];
  const fills = [
    { fill_id: "OLD", session_id: "S1", created_at: "2026-11-03T12:00:00.000Z", realized_pnl: -90000000000, fee: 0 },
    { fill_id: "PRE", session_id: "S1", created_at: "2026-11-04T12:00:00.000Z", realized_pnl: 20000000, fee: 1000000 },
    { fill_id: "IN", session_id: "S1", created_at: "2026-11-05T12:00:00.000Z", realized_pnl: -10000000, fee: 1000000 }
  ];
  const window = lib.buildPerformanceWindow(accounts, resets, fills, "2026-11-05T00:00:00.000Z");
  assert.equal(window.fillRows.length, 1);
  assert.equal(window.fillRows[0].fill_id, "IN");
  assert.equal(window.baselineBySession.S1.fixedPoint, 10000 * lib.SCALE + 19000000);
  assert.equal(window.sessionWindowStarts.S1, "2026-11-05T00:00:00.000Z");
});

test("regression: a losing FIRST fill must produce a non-zero drawdown", () => {
  // Real E2E run1 showed max_drawdown_pct = 0 when the first fill was a loss,
  // because the equity peak was seeded AFTER the first trade.
  const rows = [
    { fill_id: "F1", session_id: "S1", created_at: "2026-11-05T01:00:00.000Z", realized_pnl: -10000000, fee: 1000000 }
  ];
  const perf = lib.computeDailyPerformance(rows, { S1: 10000 });
  assert.ok(perf.max_drawdown_pct > 0, "first-loss drawdown must not be zero");
  assert.ok(lib.fpToRatio(perf.max_drawdown_pct) < 0.01);
  assert.equal(perf.days[0].trades, 1);
  assert.equal(perf.days[0].wins, 0);
});

// ------------------------------------------------- V4.3 trusted Runner anchors

test("V4.3: no trusted Runner receipt -> fail closed even with perfect evidence", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({ receipt: null }));
  assert.equal(d.eligible, false);
  assert.equal(d.evidence.receiptTrusted, false);
  assert.ok(d.reasons.some(r => r.includes("可信 Runner")));
  assert.equal(d.kelly.status, "BLOCKED");
});

test("V4.3: a local E2E / browser receipt (trusted=0) must NOT open release", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({
    receipt: { run_id: RUN_ID, trusted: 0, auth_method: "hmac-service-local-e2e", bundle_sha256: BUNDLE_SHA }
  }));
  assert.equal(d.eligible, false);
  assert.equal(d.evidence.receiptTrusted, false);
});

test("V4.3: receipt from a different research run is rejected", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({
    receipt: { run_id: "run-other", trusted: 1, auth_method: "github-actions-oidc", bundle_sha256: BUNDLE_SHA }
  }));
  assert.equal(d.eligible, false);
  assert.equal(d.evidence.receiptTrusted, false);
});

test("V4.3: browser / unknown auth method is rejected", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({
    receipt: { run_id: RUN_ID, trusted: 1, auth_method: "browser", bundle_sha256: BUNDLE_SHA }
  }));
  assert.equal(d.eligible, false);
});

test("V4.3: a riskBasis string without REAL equity snapshot evidence is rejected", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence({
    performance: {
      source: "real-d1-paper-fills",
      riskBasis: "mark-to-market-equity-snapshots",
      sessions: 1, max_drawdown_pct: 0
      // deliberately no equityEvidence
    }
  }));
  assert.equal(d.eligible, false);
  assert.equal(d.evidence.performanceAvailable, false);
  assert.ok(d.reasons.some(r => r.includes("权益快照")));
});

test("V4.3: even a fully trusted ELIGIBLE decision never enables autoExecution", () => {
  const d = lib.evaluateStrategyGate(verifiedEvidence());
  assert.equal(d.eligible, true);
  assert.equal(d.status, "ELIGIBLE");
  assert.equal(d.autoExecution, false);
  assert.equal(d.evidence.receiptTrusted, true);
  assert.equal(d.evidence.performanceRiskBasis, "mark-to-market-equity-snapshots");
});
