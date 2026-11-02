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
    assert.equal(body.thinkingMode, "disabled");
    assert.equal(body.maxTokens, 4096);
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

test("agent orchestration writes server-owned run and risk events to the authenticated D1 session", async () => {
  const { handleAgentResearch } = await modulePromise;
  const { handlePaperSession } = await import("../functions/_lib/paper-ledger.mjs");
  class AuditD1 {
    constructor() { this.sessions = new Map(); this.events = []; }
    prepare(sql) {
      const db = this;
      return { bind(...args) {
        return {
          async run() {
            if (sql.includes("INSERT INTO paper_sessions")) {
              const [sid, createdAt, expiresAt] = args;
              db.sessions.set(sid, { session_id: sid, created_at: createdAt, expires_at: expiresAt, revoked_at: null });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT OR IGNORE INTO paper_events")) {
              const [sid, eventId, eventType, payloadJson, createdAt] = args;
              if (!db.events.some(event => event.session_id === sid && event.event_id === eventId)) {
                db.events.push({ session_id: sid, event_id: eventId, event_type: eventType, payload_json: payloadJson, created_at: createdAt });
              }
              return { success: true, meta: { changes: 1 } };
            }
            throw new Error("Unexpected D1 run: " + sql);
          },
          async first() {
            if (sql.includes("SELECT session_id, expires_at, revoked_at")) return db.sessions.get(args[0]) || null;
            throw new Error("Unexpected D1 first: " + sql);
          }
        };
      }};
    }
  }
  const env = { PAPER_DB: new AuditD1(), PAPER_LEDGER_SECRET: "agent-test-secret-with-at-least-thirty-two-characters" };
  const session = await handlePaperSession(new Request("https://night-researcher.test/api/paper/session", {
    method: "POST", headers: { origin: "https://night-researcher.test", "content-type": "application/json" }, body: "{}"
  }), env);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const body = {
    runId: "123e4567-e89b-42d3-a456-426614174000",
    provider: "minimax", model: "MiniMax-M3", apiKey: "must-never-enter-ledger", region: "china",
    snapshot: { selectedSymbol: "BTCUSDT", observedPrice: 100000 }
  };
  const request = new Request("https://night-researcher.test/api/agents/research", {
    method: "POST",
    headers: { origin: "https://night-researcher.test", "content-type": "application/json", cookie },
    body: JSON.stringify(body)
  });
  const aiHandler = async internalRequest => {
    const payload = await internalRequest.json();
    const role = payload.messages[0].content.match(/AGENT_ID: ([A-Z]+)/)[1];
    const values = {
      SPOTTER: { opportunities: [] },
      PRIOR: { regime: "unknown", evidence: [], counter_evidence: [], unknowns: [] },
      EDGE: { verdict: "WATCH", invalidation: "OOS fail" },
      CLOSER: { decision: "HOLD_RESEARCH", exit_conditions: [] }
    };
    return new Response(JSON.stringify({ ok: true, model: payload.model, text: JSON.stringify(values[role]), usage: { total_tokens: 12 } }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  const response = await handleAgentResearch(request, aiHandler, env);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.runId, body.runId);
  assert.deepEqual(env.PAPER_DB.events.map(event => event.event_type), [
    "agent.run.started", "risk.decision", "agent.run.completed"
  ]);
  const decoded = env.PAPER_DB.events.map(event => JSON.parse(event.payload_json));
  assert.ok(decoded.every(event => event.runId === body.runId));
  assert.ok(decoded.every(event => !JSON.stringify(event).includes("must-never-enter-ledger")));
  assert.equal(decoded[1].decision, "BLOCKED");
  assert.equal(decoded[1].allocationPct, 0);
  assert.equal(decoded[2].snapshotHash, data.snapshotHash);
});

test("agent run preserves structured provider output failure metadata", async () => {
  const { handleAgentResearch } = await modulePromise;
  const response = await handleAgentResearch(makeRequest({
    provider: "minimax",
    model: "MiniMax-M3",
    apiKey: "mm-test-key-123456",
    region: "china",
    snapshot: { selectedSymbol: "BTCUSDT" }
  }), async () => new Response(JSON.stringify({
    ok: false,
    code: "EMPTY_FINAL_CONTENT",
    finishReason: "length",
    error: "模型在生成最终回答前达到 Token 上限"
  }), { status: 502, headers: { "content-type": "application/json" } }));
  const data = await response.json();
  assert.equal(response.status, 502);
  assert.equal(data.agent, "SPOTTER");
  assert.equal(data.providerErrorCode, "EMPTY_FINAL_CONTENT");
  assert.equal(data.finishReason, "length");
  assert.equal(data.autoExecution, false);
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
