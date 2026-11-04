// functions/_lib/paper-health.mjs — 服务存活与数据库可用性健康检查（P0-3）
//
// 要求（来自 V3.0 管理决定）：
//   健康检查必须区分「服务存活」与「数据库可用」，不能仅返回固定的 ok。
//   - /api/paper/health：服务是否存活 + D1 是否可连通 + 核心表是否齐全。
//   - /api/paper/ready：在 health 基础上额外校验签名密钥已配置，用于部署就绪判断。

import { json } from "./paper-ledger.mjs";

// D1 核心表（服务可用的最小集合）
export const REQUIRED_TABLES = [
  "paper_accounts",
  "paper_events",
  "paper_ledger",
  "paper_orders",
  "paper_sessions",
];

/**
 * 探测 D1 可用性：真实执行 SELECT 1 并校验核心表存在。
 * 返回 {status, latencyMs, coreTables, coreTablesComplete, detail}。
 */
export async function probeDatabase(env) {
  const db = env && env.PAPER_DB;
  if (!db || typeof db.prepare !== "function") {
    return {
      status: "not_configured",
      latencyMs: 0,
      coreTables: [],
      coreTablesComplete: false,
      detail: "PAPER_DB 绑定未配置（wrangler.toml 的 d1_databases.binding 必须为 PAPER_DB）",
    };
  }
  const t0 = Date.now();
  try {
    const row = await db.prepare("SELECT 1 as ok").first();
    const latencyMs = Date.now() - t0;
    const tablesRes = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN (" +
          REQUIRED_TABLES.map(() => "?").join(",") +
          ")",
      )
      .bind(...REQUIRED_TABLES)
      .all();
    const names = (tablesRes.results || []).map((r) => r.name).sort();
    const coreTablesComplete = REQUIRED_TABLES.every((n) => names.includes(n));
    return {
      status: row && row.ok === 1 ? "ok" : "error",
      latencyMs,
      coreTables: names,
      coreTablesComplete,
      detail: row && row.ok === 1 ? undefined : "SELECT 1 未返回预期结果",
    };
  } catch (e) {
    return {
      status: "error",
      latencyMs: Date.now() - t0,
      coreTables: [],
      coreTablesComplete: false,
      detail: String((e && e.message) || e).slice(0, 200),
    };
  }
}

/** GET /api/paper/health — 区分服务存活与数据库可用。 */
export async function handlePaperHealth(_request, env) {
  const started = Date.now();
  const database = await probeDatabase(env);
  const service = "ok";
  const overall = service === "ok" && database.status === "ok";
  return json(
    {
      service,
      database,
      timestamp: new Date().toISOString(),
      serviceLatencyMs: Date.now() - started,
    },
    overall ? 200 : 503,
  );
}

/** GET /api/paper/ready — 部署就绪：health + 签名密钥已配置。 */
export async function handlePaperReady(_request, env) {
  const database = await probeDatabase(env);
  const secretConfigured =
    typeof env.PAPER_LEDGER_SECRET === "string" && env.PAPER_LEDGER_SECRET.length >= 32;
  const ready = database.status === "ok" && database.coreTablesComplete && secretConfigured;
  return json(
    {
      ready,
      database,
      secretConfigured,
      timestamp: new Date().toISOString(),
    },
    ready ? 200 : 503,
  );
}
