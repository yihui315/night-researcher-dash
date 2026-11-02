const test = require("node:test");
const assert = require("node:assert/strict");

const modulePromise = import("../functions/_lib/agent-orchestrator.mjs");

function makeRequest(body) {
  return new Request("https://night-researcher.test/api/agents/research", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://night-researcher.test"
    },
    body: JSON.stringify(body)
  });
}

test("Kelly stays at zero unless historical and OOS gates both pass", async () => {
  const { computeFractionalKelly } = await modulePromise;
  const blocked = computeFractionalKelly({
    strategyPass: false,
    oosPass: false,
    sampleCount: 400,
    oosTrades: 80,
    winRate: 0.65,
    avgWinPct: 0.03,
    avgLossPct: 0.02
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.allocationPct, 0);
});

test("Kelly uses a conservative Wilson lower bound and quarter Kelly cap", async () => {
  const { computeFractionalKelly } = await modulePromise;
  const ready = computeFractionalKelly({
    strategyPass: true,
    oosPass: true,
    sampleCount: 240,
    oosTrades: 45,
    winRate: 0.58,
    avgWinPct: 0.025,
    avgLossPct: 0.02
  });
  assert.equal(ready.status, "READY");
  assert.ok(ready.conservativeWinRate < 0.58);
  assert.ok(ready.allocationPct > 0);
  assert.ok(ready.allocationPct <= 0.10);
});

test("TAKER can only produce a proposal and never auto-submit", async () => {
  const { computeFractionalKelly, buildTakerPlan } = await modulePromise;
  const kelly = computeFractionalKelly({
    strategyPass: true, oosPass: true, sampleCount: 240, oosTrades: 45,
    winRate: 0.58, avgWinPct: 0.025, avgLossPct: 0.02
  });
  const now = Date.now();
  const plan = buildTakerPlan(
    { symbol: "BTCUSDT", side: "BUY", verdict: "RESEARCH" },
    kelly,
    { structuredMarket: {
      selectedSymbol: "BTCUSDT",
      account: { equity: 10000 },
      orderBook: { capturedAt: now, asks: [[100000, 2]], bids: [[99900, 2]] }
    } }
  );
  assert.equal(plan.status, "PROPOSAL_ONLY");
  assert.equal(plan.autoSubmit, false);
  assert.equal(plan.requiresManualConfirmation, true);
  assert.ok(plan.suggestedQty > 0);
});

test("six-role pipeline calls four AI roles and keeps execution disabled", async () => {
  const { handleAgentResearch } = await modulePromise;
  const calls = [];
  const aiHandler = async request => {
    const body = await request.json();
    const prompt = body.messages[0].content;
    const match = prompt.match(/AGENT_ID: ([A-Z]+)/);
    const role = match && match[1];
    calls.push(role);
    const values = {
      SPOTTER: { opportunities: [] },
      PRIOR: { regime: "unknown", evidence: [], counter_evidence: [], unknowns: ["没有外部宏观数据"] },
      EDGE: { verdict: "WATCH", symbol: "BTCUSDT", side: "WATCH", hypothesis: "待验证", edge_source: "未知", entry_trigger: "未知", invalidation: "若成本后 OOS 失效则拒绝", costs_to_test: [], required_evidence: [] },
      CLOSER: { decision: "HOLD_RESEARCH", exit_conditions: [], failure_modes: ["样本不足"], next_validation: ["等待独立 OOS 数据"], final_risk_note: "不执行交易" }
    };
    return new Response(JSON.stringify({
      ok: true,
      model: body.model,
      text: JSON.stringify(values[role]),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const response = await handleAgentResearch(makeRequest({
    provider: "minimax",
    model: "MiniMax-M3",
    apiKey: "mm-test-key-123456",
    region: "china",
    snapshot: { selectedSymbol: "BTCUSDT", tickers: {}, strategyMetrics: { strategyPass: true, oosPass: true, sampleCount: 1000, oosTrades: 100, winRate: 0.9, avgWinPct: 0.1, avgLossPct: 0.01 } }
  }), aiHandler);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.match(data.runId, /^[0-9a-f-]{36}$/i);
  assert.match(data.snapshotHash, /^[0-9a-f]{64}$/);
  assert.equal(data.promptVersion, "nr-agent-research-v1");
  assert.equal(data.provider, "minimax");
  assert.equal(data.requestedModel, "MiniMax-M3");
  assert.ok(data.durationMs >= 0);
  assert.deepEqual(calls, ["SPOTTER", "PRIOR", "EDGE", "CLOSER"]);
  assert.deepEqual(data.roles, ["SPOTTER", "PRIOR", "EDGE", "KELLY", "TAKER", "CLOSER"]);
  assert.equal(data.outputs.KELLY.status, "BLOCKED");
  assert.equal(data.outputs.TAKER.autoSubmit, false);
  assert.equal(data.safety.autoExecution, false);
  assert.equal(data.safety.paperOrderCreated, false);
});

test("TAKER blocks WATCH and REJECT decisions even if a Kelly size exists", async () => {
  const { computeFractionalKelly, buildTakerPlan } = await modulePromise;
  const kelly = computeFractionalKelly({
    strategyPass: true, oosPass: true, sampleCount: 240, oosTrades: 45,
    winRate: 0.58, avgWinPct: 0.025, avgLossPct: 0.02
  });
  const plan = buildTakerPlan({ symbol: "BTCUSDT", side: "BUY", verdict: "WATCH" }, kelly, {
    structuredMarket: {
      selectedSymbol: "BTCUSDT",
      account: { equity: 10000 },
      orderBook: { capturedAt: Date.now(), asks: [[100000, 2]], bids: [[99900, 2]] }
    }
  });
  assert.equal(plan.status, "BLOCKED");
  assert.equal(plan.autoSubmit, false);
});
