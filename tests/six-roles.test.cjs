const test = require("node:test");
const assert = require("node:assert/strict");

const pipelineModule = import("../functions/_lib/six-roles/pipeline.mjs");
const schemaModule = import("../functions/_lib/six-roles/schema.mjs");
const mockModule = import("../functions/_lib/six-roles/mockAi.mjs");

function makeSnapshot(overrides = {}) {
  const now = Date.now();
  return {
    snapshot_id: "snap-BTCUSDT-20261103-abc123",
    selectedSymbol: "BTCUSDT",
    symbol: "BTCUSDT",
    tickers: { BTCUSDT: { lastPrice: 100000 } },
    orderBook: { capturedAt: now, asks: [[100000, 2]], bids: [[99900, 2]] },
    account: { equity: 10000 },
    ...overrides
  };
}

const HAPPY_ROLES = {
  SPOTTER: { opportunities: [{ symbol: "BTCUSDT", setup: "区间下沿反弹", evidence: ["tickers.BTCUSDT.lastPrice"], missing_data: [], watch_only: true }] },
  PRIOR: { regime: "range", prior_confidence: 0.42, evidence: ["价格位于区间"], counter_evidence: [], unknowns: ["宏观流动性"] },
  EDGE: { verdict: "RESEARCH", symbol: "BTCUSDT", side: "BUY", hypothesis: "均值回归", edge_source: "历史样本", entry_trigger: "触及下沿", invalidation: "跌破区间", costs_to_test: ["手续费"], required_evidence: ["历史样本>=100", "OOS 通过"] },
  CLOSER: { decision: "HOLD_RESEARCH", exit_conditions: ["价格跌破区间下沿"], failure_modes: ["样本偏差"], next_validation: ["等待独立 OOS"], final_risk_note: "不执行真实订单" }
};

const GOOD_METRICS = {
  strategyPass: true, oosPass: true, sampleCount: 240, oosTrades: 45,
  winRate: 0.58, avgWinPct: 0.025, avgLossPct: 0.02
};

test("every role record carries all required fields", async () => {
  const { runCycle } = await pipelineModule;
  const { validateRoleRecord, REQUIRED_FIELDS, ROLE_IDS } = await schemaModule;
  const { mockModelCaller } = await mockModule;
  const caller = mockModelCaller(HAPPY_ROLES);
  const result = await runCycle({
    runId: "11111111-1111-4111-8111-111111111111",
    strategyId: "strat-mean-reversion",
    strategyVersion: "v1.2.0",
    marketSnapshot: makeSnapshot(),
    modelCaller: caller,
    metrics: GOOD_METRICS
  });
  for (const roleId of ROLE_IDS) {
    const rec = result.roles[roleId];
    const { valid, errors } = validateRoleRecord(rec);
    assert.ok(valid, roleId + " 校验失败: " + errors.join("; "));
    for (const f of REQUIRED_FIELDS) assert.ok(f in rec, roleId + " 缺少 " + f);
  }
});

test("decision-chain id is consistent across all six roles", async () => {
  const { runCycle } = await pipelineModule;
  const { validateRoleRecord, validateDecisionChain, REQUIRED_FIELDS, ROLE_IDS } = await schemaModule;
  const { mockModelCaller } = await mockModule;
  const caller = mockModelCaller(HAPPY_ROLES);
  const runId = "22222222-2222-4222-8222-222222222222";
  const result = await runCycle({
    runId, strategyId: "s", strategyVersion: "v1",
    marketSnapshot: makeSnapshot(), modelCaller: caller, metrics: GOOD_METRICS
  });
  assert.equal(result.decision_chain_id, runId);
  for (const roleId of ROLE_IDS) {
    assert.equal(result.roles[roleId].decision_chain_id, runId, roleId + " 链路 id 不一致");
    assert.equal(result.roles[roleId].run_id, runId);
  }
  const { valid, errors } = validateDecisionChain(result.roles, { decisionChainId: runId });
  assert.ok(valid, errors.join("; "));
});

test("EDGE is rejected when no verifiable evidence is supplied", async () => {
  const { runCycle } = await pipelineModule;
  const { mockModelCaller } = await mockModule;
  const caller = mockModelCaller({
    ...HAPPY_ROLES,
    EDGE: { verdict: "WATCH", symbol: "BTCUSDT", side: "WATCH", hypothesis: "", invalidation: "x", required_evidence: [] }
  });
  const result = await runCycle({
    runId: "33333333-3333-4333-8333-333333333333",
    strategyId: "s", strategyVersion: "v1",
    marketSnapshot: makeSnapshot(), modelCaller: caller, metrics: GOOD_METRICS
  });
  assert.equal(result.roles.EDGE.decision, "REJECT");
  assert.ok(result.roles.EDGE.rejection_reason.length > 0, "EDGE 拒绝应有原因");
  assert.equal(result.roles.TAKER.proposal_status, "BLOCKED");
});

test("EDGE is rejected when required_evidence array is empty", async () => {
  const { runCycle } = await pipelineModule;
  const { mockModelCaller } = await mockModule;
  const caller = mockModelCaller({
    ...HAPPY_ROLES,
    EDGE: { verdict: "RESEARCH", symbol: "BTCUSDT", side: "BUY", hypothesis: "x", invalidation: "x", required_evidence: [] }
  });
  const result = await runCycle({
    runId: "44444444-4444-4444-8444-444444444444",
    strategyId: "s", strategyVersion: "v1",
    marketSnapshot: makeSnapshot(), modelCaller: caller, metrics: GOOD_METRICS
  });
  assert.equal(result.roles.EDGE.decision, "REJECT");
  assert.match(result.roles.EDGE.rejection_reason, /required_evidence/);
});

test("KELLY outputs size=0 with rejection_reason when sample requirement unmet", async () => {
  const { runCycle } = await pipelineModule;
  const { mockModelCaller } = await mockModule;
  const caller = mockModelCaller(HAPPY_ROLES);
  const result = await runCycle({
    runId: "55555555-5555-4555-8555-555555555555",
    strategyId: "s", strategyVersion: "v1",
    marketSnapshot: makeSnapshot(), modelCaller: caller,
    metrics: { strategyPass: true, oosPass: true, sampleCount: 40, oosTrades: 10, winRate: 0.6, avgWinPct: 0.03, avgLossPct: 0.02 }
  });
  assert.equal(result.roles.KELLY.size, 0, "样本不足时 KELLY size 必须为 0");
  assert.equal(result.roles.KELLY.decision, "REJECT");
  assert.ok(result.roles.KELLY.rejection_reason.length > 0);
  assert.equal(result.roles.KELLY.promoted_to_live, false);
});

test("OOS not passed prevents promotion to the live pool", async () => {
  const { runCycle } = await pipelineModule;
  const { mockModelCaller } = await mockModule;
  const caller = mockModelCaller(HAPPY_ROLES);
  const result = await runCycle({
    runId: "66666666-6666-4666-8666-666666666666",
    strategyId: "s", strategyVersion: "v1",
    marketSnapshot: makeSnapshot(), modelCaller: caller,
    metrics: { strategyPass: true, oosPass: false, sampleCount: 500, oosTrades: 60, winRate: 0.6, avgWinPct: 0.03, avgLossPct: 0.02 }
  });
  assert.equal(result.roles.KELLY.status, "BLOCKED");
  assert.equal(result.roles.KELLY.promoted_to_live, false);
  assert.equal(result.livePoolEligible, false);
});

test("TAKER only produces a proposal and never mutates the account", async () => {
  const { runCycle } = await pipelineModule;
  const { mockModelCaller } = await mockModule;
  const caller = mockModelCaller(HAPPY_ROLES);
  const account = { equity: 10000, cash: "10000.00000000", positions: {} };
  const result = await runCycle({
    runId: "77777777-7777-4777-8777-777777777777",
    strategyId: "s", strategyVersion: "v1",
    marketSnapshot: makeSnapshot(), modelCaller: caller, metrics: GOOD_METRICS, account
  });
  assert.equal(result.roles.TAKER.proposal_status, "PROPOSAL_ONLY");
  assert.equal(result.roles.TAKER.decision, "PROPOSAL");
  assert.ok(result.roles.TAKER.__accountUntouched, "TAKER 不得改动账户对象");
  assert.equal(account.equity, 10000, "账户净值未被改动");
  assert.deepEqual(account.positions, {}, "账户持仓未被改动");
  const proposal = result.roles.TAKER.proposal;
  assert.ok(proposal && proposal.type === "PaperOrderProposal");
  assert.equal(proposal.confirmationId, "PENDING_HUMAN_CONFIRMATION", "提案须带确认占位符");
  assert.equal(proposal.autoSubmit, false);
  assert.equal(proposal.requiresManualConfirmation, true);
});

test("CLOSER records a non-empty exit_reason", async () => {
  const { runCycle } = await pipelineModule;
  const { mockModelCaller } = await mockModule;
  const caller = mockModelCaller(HAPPY_ROLES);
  const result = await runCycle({
    runId: "88888888-8888-4888-8888-888888888888",
    strategyId: "s", strategyVersion: "v1",
    marketSnapshot: makeSnapshot(), modelCaller: caller, metrics: GOOD_METRICS
  });
  assert.ok(result.roles.CLOSER.exit_reason.length > 0, "CLOSER 必须记录 exit_reason");
  assert.equal(result.roles.CLOSER.decision, "HOLD_RESEARCH");
});

test("happy path promotes and proposes without auto-execution", async () => {
  const { runCycle } = await pipelineModule;
  const { mockModelCaller } = await mockModule;
  const caller = mockModelCaller(HAPPY_ROLES);
  const result = await runCycle({
    runId: "99999999-9999-4999-8999-999999999999",
    strategyId: "strat-mean-reversion", strategyVersion: "v1.2.0",
    marketSnapshot: makeSnapshot(), modelCaller: caller, metrics: GOOD_METRICS
  });
  assert.equal(result.roles.KELLY.status, "READY");
  assert.ok(result.roles.KELLY.size > 0);
  assert.equal(result.roles.KELLY.promoted_to_live, true);
  assert.equal(result.roles.TAKER.proposal_status, "PROPOSAL_ONLY");
  assert.equal(result.finalDecision, "PROMOTE_AND_PROPOSE");
});
