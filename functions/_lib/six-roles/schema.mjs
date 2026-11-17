// Six-role decision system — unified record schema (plain object definitions + validator).
//
// Every role record in the SPOTTER→PRIOR→EDGE→KELLY→TAKER→CLOSER pipeline MUST carry
// the base fields below so a full decision chain is traceable and auditable. The records
// are deterministic server-side artifacts; the AI roles (SPOTTER/PRIOR/EDGE/CLOSER) only
// contribute structured research conclusions, while KELLY/TAKER are pure deterministic programs.
//
// NOTE: this module intentionally has no AI / network dependency so it can be unit-tested in
// isolation. It is consumed by pipeline.mjs.

// Roles executed, in order, for one decision cycle.
export const ROLE_IDS = Object.freeze(["SPOTTER", "PRIOR", "EDGE", "KELLY", "TAKER", "CLOSER"]);

// AI-driven roles (model calls); the rest are deterministic.
export const AI_ROLE_IDS = Object.freeze(["SPOTTER", "PRIOR", "EDGE", "CLOSER"]);

// Base fields every role record must include. These are also what the audit ledger expects.
export const REQUIRED_FIELDS = Object.freeze([
  "decision_chain_id", // links all six roles within a single cycle (== run_id)
  "run_id",
  "strategy_id",
  "strategy_version",
  "market_snapshot_id",
  "provider",
  "model",
  "prompt_tokens",
  "completion_tokens",
  "latency_ms",
  "decision",
  "rejection_reason"
]);

// Plain-object schema for each role's *structured* payload (in addition to the base fields).
// This documents the shape; the validator below only enforces the base fields + a few
// role-specific sanity checks so the pipeline stays flexible.
export const SCHEMAS = Object.freeze({
  SPOTTER: {
    description: "机会发现：扫描快照提出候选机会（仅 watch_only，不得虚构事实）。",
    fields: {
      opportunities: "Array<{symbol, setup, evidence[], missing_data[], watch_only}>",
      opportunity_count: "number"
    }
  },
  PRIOR: {
    description: "市场先验：判断市场状态与先验假设，区分事实与推断。",
    fields: {
      regime: "risk_on|risk_off|range|unknown",
      prior_confidence: "number 0..1",
      evidence: "string[]",
      counter_evidence: "string[]",
      unknowns: "string[]"
    }
  },
  EDGE: {
    description: "优势验证：审查是否存在可证伪的统计优势（含成本与样本量）。",
    fields: {
      verdict: "RESEARCH|WATCH|REJECT",
      symbol: "string",
      side: "BUY|SELL|WATCH",
      required_evidence: "string[]",
      edge_source: "string"
    }
  },
  KELLY: {
    description: "仓位上限：确定性 Wilson 下界 + 四分之一 Kelly，样本/OOS 门禁。",
    fields: {
      size: "number (fraction of equity, 0 if blocked)",
      status: "READY|BLOCKED",
      promoted_to_live: "boolean",
      reasons: "string[]"
    }
  },
  TAKER: {
    description: "下单提案：仅生成 PaperOrderProposal，绝不下单或改动账户。",
    fields: {
      proposal: "PaperOrderProposal|null",
      proposal_status: "PROPOSAL_ONLY|BLOCKED"
    }
  },
  CLOSER: {
    description: "退出与复盘：独立审查，必须记录 exit_reason。",
    fields: {
      exit_reason: "string (non-empty)",
      decision: "HOLD_RESEARCH|REJECT|MONITOR",
      failure_modes: "string[]"
    }
  }
});

// Minimum sample count KELLY requires before it may allocate (mirrors computeFractionalKelly).
export const KELLY_SAMPLE_THRESHOLD = 100;
export const KELLY_OOS_TRADES_THRESHOLD = 30;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Validate that a role record carries every required base field with the right shape.
// Returns { valid: boolean, errors: string[] }.
export function validateRoleRecord(record) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { valid: false, errors: ["record 必须是普通对象"] };
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) {
      errors.push("缺少必填字段: " + field);
      continue;
    }
    const value = record[field];
    if (field === "prompt_tokens" || field === "completion_tokens" || field === "latency_ms") {
      if (!isFiniteNumber(value) || value < 0) errors.push(field + " 必须是 >=0 的有限数字");
    } else if (field === "decision") {
      if (typeof value !== "string" || value.length === 0) errors.push("decision 必须是非空字符串");
    } else if (field === "rejection_reason") {
      if (typeof value !== "string") errors.push("rejection_reason 必须是字符串（可空）");
    } else {
      if (typeof value !== "string" || value.length === 0) errors.push(field + " 必须是非空字符串");
    }
  }
  return { valid: errors.length === 0, errors };
}

// Validate the full set of six role records produced by one cycle.
export function validateDecisionChain(roles, { decisionChainId } = {}) {
  const errors = [];
  for (const roleId of ROLE_IDS) {
    const record = roles && roles[roleId];
    if (!record) {
      errors.push("缺少角色记录: " + roleId);
      continue;
    }
    const { valid, errors: recErrors } = validateRoleRecord(record);
    if (!valid) errors.push(roleId + ": " + recErrors.join("; "));
    if (decisionChainId !== undefined && record.decision_chain_id !== decisionChainId) {
      errors.push(roleId + ": decision_chain_id 与链路不一致");
    }
  }
  return { valid: errors.length === 0, errors };
}
