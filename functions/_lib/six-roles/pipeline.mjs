// Six-role decision pipeline (pure orchestration).
//
// Order: SPOTTER → PRIOR → EDGE → KELLY → TAKER → CLOSER
//
// SPOTTER/PRIOR/EDGE/CLOSER are AI research roles (model calls via the thin adapter).
// KELLY and TAKER are DETERMINISTIC server-side programs reused from agent-orchestrator:
//   - computeFractionalKelly  -> Wilson lower-bound quarter-Kelly with sample/OOS gates
//   - buildTakerPlan          -> produces a PROPOSAL_ONLY object; never creates an order
//
// GATE RULES (implemented as explicit code below):
//   G1  EDGE may not advance without evidence -> decision=REJECT + rejection_reason.
//   G2  KELLY outputs size=0 (with rejection_reason) when sample requirement unmet.
//   G3  OOS not passed => strategy NOT promoted to the live pool.
//   G4  TAKER only produces a PaperOrderProposal; it MUST NOT call createPaperOrder or
//       mutate any account. The proposal carries a confirmationId placeholder for human
//       confirmation + server risk control.
//   G5  CLOSER must record an exit_reason.

import { computeFractionalKelly, buildTakerPlan } from "../agent-orchestrator.mjs";
import { createModelCaller, parseAgentObject } from "./adapter.mjs";
import {
  ROLE_IDS,
  KELLY_SAMPLE_THRESHOLD,
  KELLY_OOS_TRADES_THRESHOLD
} from "./schema.mjs";

export const ALLOWED_SYMBOLS = Object.freeze(new Set(["BTCUSDT", "ETHUSDT", "ORDIUSDT", "1000SATSUSDT"]));

// Per-role research instructions (kept close to the existing agent-orchestrator prompts).
const ROLE_INSTRUCTIONS = Object.freeze({
  SPOTTER:
    "扫描给定快照，最多提出 3 个候选机会。只允许使用快照中出现的交易对和事实字段。没有可靠机会就返回空数组。输出 JSON：{\"opportunities\":[{\"symbol\":\"BTCUSDT\",\"setup\":\"...\",\"evidence\":[\"引用具体快照字段\"],\"missing_data\":[\"...\"],\"watch_only\":true}]}。不得虚构价格、成交、大额交易或链上事件。",
  PRIOR:
    "基于快照及 SPOTTER 结果判断市场状态和先验假设。区分事实与推断。输出 JSON：{\"regime\":\"risk_on|risk_off|range|unknown\",\"prior_confidence\":0.0,\"evidence\":[\"...\"],\"counter_evidence\":[\"...\"],\"unknowns\":[\"...\"]}。",
  EDGE:
    "审查候选机会是否存在可证伪的统计优势。必须考虑手续费、价差、滑点、流动性、样本量、OOS 和对照基准。不要编造胜率或样本数。输出 JSON：{\"verdict\":\"RESEARCH|WATCH|REJECT\",\"symbol\":\"BTCUSDT或空字符串\",\"side\":\"BUY|SELL|WATCH\",\"hypothesis\":\"...\",\"edge_source\":\"...\",\"entry_trigger\":\"...\",\"invalidation\":\"...\",\"costs_to_test\":[\"...\"],\"required_evidence\":[\"...\"]}。",
  CLOSER:
    "作为最后一道独立审查，审视前面所有结果、确定性 KELLY 计算和 TAKER 计划。指出最脆弱的假设，给出退出/失效条件和下一步验证。不能批准真实订单。输出 JSON：{\"decision\":\"HOLD_RESEARCH|REJECT|MONITOR\",\"exit_conditions\":[\"...\"],\"failure_modes\":[\"...\"],\"next_validation\":[\"...\"],\"final_risk_note\":\"...\"}。"
});

// Minimal structural validators for the four AI-role outputs (mirror agent-orchestrator intent).
function validateAiOutput(role, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (role === "SPOTTER") {
    return Array.isArray(value.opportunities) && value.opportunities.length <= 3
      && value.opportunities.every(it =>
        it && typeof it === "object" && ALLOWED_SYMBOLS.has(String(it.symbol || ""))
        && typeof it.setup === "string" && Array.isArray(it.evidence)
        && Array.isArray(it.missing_data) && it.watch_only === true);
  }
  if (role === "PRIOR") {
    return ["risk_on", "risk_off", "range", "unknown"].includes(value.regime)
      && Array.isArray(value.evidence) && Array.isArray(value.counter_evidence)
      && Array.isArray(value.unknowns);
  }
  if (role === "EDGE") {
    return ["RESEARCH", "WATCH", "REJECT"].includes(value.verdict)
      && (value.symbol === "" || ALLOWED_SYMBOLS.has(String(value.symbol || "")))
      && ["BUY", "SELL", "WATCH"].includes(value.side)
      && typeof value.invalidation === "string"
      && Array.isArray(value.required_evidence);
  }
  if (role === "CLOSER") {
    return ["HOLD_RESEARCH", "REJECT", "MONITOR"].includes(value.decision)
      && Array.isArray(value.exit_conditions) && Array.isArray(value.failure_modes || [])
      && Array.isArray(value.next_validation || []);
  }
  return false;
}

// Build the base record shared by every role (satisfies REQUIRED_FIELDS).
function baseRecord({ decisionChainId, runId, strategyId, strategyVersion, snapshotId, modelCaller, decision, rejectionReason }) {
  return {
    decision_chain_id: decisionChainId,
    run_id: runId,
    strategy_id: strategyId,
    strategy_version: strategyVersion,
    market_snapshot_id: snapshotId,
    provider: modelCaller.provider,
    model: modelCaller.model,
    prompt_tokens: 0,
    completion_tokens: 0,
    latency_ms: 0,
    decision,
    rejection_reason: rejectionReason || ""
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Run one full decision cycle across all six roles.
// opts: {
//   runId, strategyId, strategyVersion, marketSnapshot (must include snapshot_id + structuredMarket-like fields),
//   modelCaller (from createModelCaller), metrics (strategy/performance metrics for KELLY),
//   account (read-only paper account snapshot; TAKER must not mutate)
// }
export async function runCycle(opts) {
  const {
    runId,
    strategyId,
    strategyVersion,
    marketSnapshot,
    modelCaller,
    metrics = {},
    account
  } = opts;

  const decisionChainId = runId; // one id links the whole chain
  const snapshotId = marketSnapshot && (marketSnapshot.snapshot_id || marketSnapshot.id || "unknown");
  const roles = {};

  // ---- SPOTTER (AI) ----
  {
    const startedAt = Date.now();
    const out = await callAiRole(modelCaller, "SPOTTER", {
      marketSnapshot,
      priorAgentResults: {}
    });
    const latency = Date.now() - startedAt;
    const opportunities = (out.parsed && out.parsed.opportunities) || [];
    const record = baseRecord({
      decisionChainId, runId, strategyId, strategyVersion, snapshotId, modelCaller,
      decision: opportunities.length ? "OPPORTUNITY" : "NONE",
      rejectionReason: opportunities.length ? "" : "SPOTTER 未发现可观测的候选机会"
    });
    record.prompt_tokens = out.usage.prompt_tokens;
    record.completion_tokens = out.usage.completion_tokens;
    record.latency_ms = latency;
    record.opportunities = opportunities;
    record.opportunity_count = opportunities.length;
    roles.SPOTTER = record;
  }

  // ---- PRIOR (AI) ----
  {
    const startedAt = Date.now();
    const out = await callAiRole(modelCaller, "PRIOR", {
      marketSnapshot,
      priorAgentResults: { SPOTTER: roles.SPOTTER.opportunities }
    });
    const latency = Date.now() - startedAt;
    const prior = out.parsed || {};
    const regime = prior.regime || "unknown";
    const record = baseRecord({
      decisionChainId, runId, strategyId, strategyVersion, snapshotId, modelCaller,
      decision: regime !== "unknown" ? "REGIME_SET" : "UNKNOWN_REGIME",
      rejectionReason: regime === "unknown" ? "市场状态未知，先验置信不足" : ""
    });
    record.prompt_tokens = out.usage.prompt_tokens;
    record.completion_tokens = out.usage.completion_tokens;
    record.latency_ms = latency;
    record.regime = regime;
    record.prior_confidence = typeof prior.prior_confidence === "number" ? prior.prior_confidence : null;
    record.evidence = prior.evidence || [];
    record.counter_evidence = prior.counter_evidence || [];
    record.unknowns = prior.unknowns || [];
    roles.PRIOR = record;
  }

  // ---- EDGE (AI) with GATE G1 ----
  let edgePassed = false;
  {
    const startedAt = Date.now();
    const out = await callAiRole(modelCaller, "EDGE", {
      marketSnapshot,
      priorAgentResults: { SPOTTER: roles.SPOTTER.opportunities, PRIOR: { regime: roles.PRIOR.regime } }
    });
    const latency = Date.now() - startedAt;
    const edge = out.parsed || {};
    const verdict = edge.verdict;
    const requiredEvidence = Array.isArray(edge.required_evidence) ? edge.required_evidence : [];
    const hasSymbol = ALLOWED_SYMBOLS.has(String(edge.symbol || ""));
    const hasSide = ["BUY", "SELL"].includes(edge.side);

    // G1: EDGE may not advance without evidence.
    let decision = "PASS";
    let rejectionReason = "";
    if (verdict !== "RESEARCH") {
      decision = "REJECT";
      rejectionReason = "EDGE 未给出 RESEARCH 结论（verdict=" + String(verdict) + "）";
    } else if (!hasSymbol) {
      decision = "REJECT";
      rejectionReason = "EDGE 缺少白名单内的交易对";
    } else if (!hasSide) {
      decision = "REJECT";
      rejectionReason = "EDGE 未给出可执行的交易方向";
    } else if (requiredEvidence.length === 0) {
      decision = "REJECT";
      rejectionReason = "EDGE 缺少可证伪证据（required_evidence 为空）";
    } else {
      edgePassed = true;
    }

    const record = baseRecord({
      decisionChainId, runId, strategyId, strategyVersion, snapshotId, modelCaller,
      decision, rejectionReason
    });
    record.prompt_tokens = out.usage.prompt_tokens;
    record.completion_tokens = out.usage.completion_tokens;
    record.latency_ms = latency;
    record.verdict = verdict || "";
    record.symbol = edge.symbol || "";
    record.side = edge.side || "WATCH";
    record.required_evidence = requiredEvidence;
    record.hypothesis = edge.hypothesis || null;
    record.invalidation = edge.invalidation || "";
    roles.EDGE = record;
  }

  // ---- KELLY (deterministic) with GATES G2 + G3 ----
  let kellyReady = false;
  let promotedToLive = false;
  {
    const m = normalizeMetrics(metrics);
    const kelly = computeFractionalKelly(m);
    const blocked = kelly.status !== "READY";
    kellyReady = !blocked;
    // G3: only promote if OOS passed AND kelly ready (computeFractionalKelly already blocks on oosPass).
    promotedToLive = kellyReady && m.oosPass === true;
    // G2: size must be 0 (with reason) when sample requirement unmet.
    const size = blocked ? 0 : Number(kelly.allocationPct || 0);
    const sampleShort = m.sampleCount < KELLY_SAMPLE_THRESHOLD;

    let decision = blocked ? "REJECT" : "ALLOCATE";
    let rejectionReason = blocked ? (kelly.reasons || []).join("; ") : "";
    if (sampleShort && !blocked) {
      // defensive: ensure size 0 if sample short even if thresholds changed
      decision = "REJECT";
      rejectionReason = "样本数不足 " + KELLY_SAMPLE_THRESHOLD + "，KELLY 强制 size=0";
    }

    const record = baseRecord({
      decisionChainId, runId, strategyId, strategyVersion, snapshotId, modelCaller,
      decision, rejectionReason
    });
    record.size = size;
    record.status = kelly.status;
    record.sample_count = m.sampleCount;
    record.oos_trades = m.oosTrades;
    record.strategy_pass = m.strategyPass === true;
    record.oos_pass = m.oosPass === true;
    record.promoted_to_live = promotedToLive;
    record.reasons = kelly.reasons || [];
    record.allocationPct = kelly.allocationPct || 0;
    roles.KELLY = record;
  }

  // ---- TAKER (deterministic, proposal-only) with GATE G4 ----
  {
    const edgePayload = {
      verdict: edgePassed ? "RESEARCH" : (roles.EDGE.verdict || "WATCH"),
      symbol: roles.EDGE.symbol || "",
      side: roles.EDGE.side || "WATCH"
    };
    const kellyPayload = kellyReady ? { status: "READY", allocationPct: roles.KELLY.allocationPct } : { status: "BLOCKED", allocationPct: 0 };

    // G4: pass a CLONE of the account; TAKER must never mutate the real account.
    const accountClone = account ? deepClone(account) : undefined;
    const structuredMarket = buildStructuredMarket(marketSnapshot, accountClone);
    const plan = buildTakerPlan(edgePayload, kellyPayload, { structuredMarket });

    let decision = plan.status === "PROPOSAL_ONLY" ? "PROPOSAL" : "REJECT";
    let rejectionReason = plan.status === "BLOCKED" ? (plan.reason || "TAKER 被风控拦截") : "";

    const record = baseRecord({
      decisionChainId, runId, strategyId, strategyVersion, snapshotId, modelCaller,
      decision, rejectionReason
    });
    record.proposal_status = plan.status;

    if (plan.status === "PROPOSAL_ONLY") {
      // PaperOrderProposal — carries a confirmationId placeholder, never an executed order.
      record.proposal = {
        type: "PaperOrderProposal",
        symbol: plan.symbol,
        side: plan.side,
        referenceAsk: plan.referenceAsk,
        referenceBid: plan.referenceBid,
        targetNotional: plan.targetNotional,
        suggestedQty: plan.suggestedQty,
        autoSubmit: false,
        requiresManualConfirmation: true,
        confirmationId: "PENDING_HUMAN_CONFIRMATION",
        note: plan.note || "仅纸面提案；须人工确认并重新通过 paper-engine 风控"
      };
    } else {
      record.proposal = null;
    }
    roles.TAKER = record;

    // G4 assertion surface: expose whether the account object was mutated by TAKER.
    roles.TAKER.__accountUntouched = account ? JSON.stringify(account) === JSON.stringify(accountClone) : true;
  }

  // ---- CLOSER (AI) with GATE G5 ----
  {
    const startedAt = Date.now();
    const out = await callAiRole(modelCaller, "CLOSER", {
      marketSnapshot,
      priorAgentResults: {
        SPOTTER: roles.SPOTTER.opportunities,
        PRIOR: { regime: roles.PRIOR.regime },
        EDGE: { verdict: roles.EDGE.verdict, symbol: roles.EDGE.symbol },
        KELLY: { size: roles.KELLY.size, status: roles.KELLY.status },
        TAKER: { proposal_status: roles.TAKER.proposal_status }
      }
    });
    const latency = Date.now() - startedAt;
    const closer = out.parsed || {};
    const decision = closer.decision || "HOLD_RESEARCH";
    // G5: CLOSER must record an exit_reason.
    const exitReason = Array.isArray(closer.exit_conditions) && closer.exit_conditions.length
      ? closer.exit_conditions.join("; ")
      : (decision === "REJECT"
          ? ("CLOSER 拒绝: " + (Array.isArray(closer.failure_modes) ? closer.failure_modes.join("; ") : "未提供失效模式"))
          : "未在 exit_conditions 中声明退出条件（默认持有研究）");

    const record = baseRecord({
      decisionChainId, runId, strategyId, strategyVersion, snapshotId, modelCaller,
      decision, rejectionReason: decision === "REJECT" ? exitReason : ""
    });
    record.prompt_tokens = out.usage.prompt_tokens;
    record.completion_tokens = out.usage.completion_tokens;
    record.latency_ms = latency;
    record.exit_reason = exitReason;
    record.failure_modes = closer.failure_modes || [];
    record.next_validation = closer.next_validation || [];
    record.final_risk_note = closer.final_risk_note || "";
    roles.CLOSER = record;
  }

  const anyReject = ROLE_IDS.some(r => roles[r].decision === "REJECT");
  const finalDecision = promotedToLive && roles.TAKER.proposal_status === "PROPOSAL_ONLY" && !anyReject
    ? "PROMOTE_AND_PROPOSE"
    : (anyReject ? "REJECTED_CHAIN" : "RESEARCH_ONLY");

  return {
    decision_chain_id: decisionChainId,
    run_id: runId,
    strategy_id: strategyId,
    strategy_version: strategyVersion,
    market_snapshot_id: snapshotId,
    livePoolEligible: promotedToLive,
    finalDecision,
    roles,
    summary: {
      spotter: roles.SPOTTER.decision,
      prior: roles.PRIOR.regime,
      edge: roles.EDGE.decision,
      kelly: roles.KELLY.status,
      kellySize: roles.KELLY.size,
      taker: roles.TAKER.proposal_status,
      closer: roles.CLOSER.decision,
      promotedToLive
    }
  };
}

async function callAiRole(modelCaller, roleId, context) {
  const content = [
    "你正在执行 Night Researcher 六角色研究流程。",
    "只允许使用输入快照中的可观察事实；未知就明确写 unknown。禁止编造行情、订单簿、链上事件、资金流、成交或回测结果。",
    "输出必须是一个 JSON 对象，不要 Markdown 代码块，不要在 JSON 之外输出文字。",
    "AGENT_ID: " + roleId,
    "AGENT_TITLE: " + roleId,
    "ROLE_INSTRUCTIONS: " + ROLE_INSTRUCTIONS[roleId],
    "INPUT_CONTEXT_JSON:",
    JSON.stringify(context)
  ].join("\n");
  const result = await modelCaller.callModel([{ role: "user", content }]);
  const parsed = parseAgentObject(result.text);
  if (!validateAiOutput(roleId, parsed)) {
    const err = new Error("角色 " + roleId + " 未返回符合约定的结构化 JSON");
    err.role = roleId;
    err.code = "INVALID_AGENT_OUTPUT";
    throw err;
  }
  return { parsed, usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

function normalizeMetrics(metrics) {
  const m = metrics && typeof metrics === "object" ? metrics : {};
  return {
    strategyPass: m.strategyPass === true,
    oosPass: m.oosPass === true,
    sampleCount: Number(m.sampleCount || m.trades || 0),
    oosTrades: Number(m.oosTrades || 0),
    winRate: Number(m.winRate),
    avgWinPct: Number(m.avgWinPct),
    avgLossPct: Math.abs(Number(m.avgLossPct))
  };
}

function buildStructuredMarket(marketSnapshot, account) {
  // Tolerantly build a structuredMarket for buildTakerPlan from whatever snapshot we get.
  const snap = marketSnapshot && typeof marketSnapshot === "object" ? marketSnapshot : {};
  const nested = snap.structuredMarket && typeof snap.structuredMarket === "object" ? snap.structuredMarket : {};
  const orderBook = snap.orderBook || nested.orderBook || { capturedAt: 0, asks: [], bids: [] };
  const symbol = snap.selectedSymbol || snap.symbol || nested.selectedSymbol || "";
  return {
    selectedSymbol: symbol,
    account: account || snap.account || nested.account || { equity: 0 },
    orderBook: {
      capturedAt: orderBook.capturedAt || 0,
      asks: orderBook.asks || [],
      bids: orderBook.bids || []
    }
  };
}
