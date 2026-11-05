/**
 * GET  /api/strategy/equity-snapshots  - read real snapshots + risk basis
 * POST /api/strategy/equity-snapshots  - trusted server-side collection ONLY
 *
 * The POST path requires a signed service request. It NEVER accepts
 * client-supplied equity values: every number is recomputed server-side from
 * paper_accounts.state_json and real Binance marks.
 */
import { json, isSameOrigin, requireConfig, readSession } from "../../_lib/paper-ledger.mjs";
import { verifyServiceSignature } from "../../_lib/service-auth.mjs";
import {
  collectEquitySnapshots, buildEquityRiskBasis, MAX_SNAPSHOT_AGE_MS, MIN_VERIFIED_SNAPSHOTS
} from "../../_lib/equity-snapshot.mjs";
import { appendStrategyEvent, verifyStrategyEventChain } from "../../_lib/strategy-events.mjs";

function tablesMissing(error, label) {
  return json({
    ok: false, code: "EQUITY_TABLES_MISSING",
    error: "权益快照表不存在，请先应用 migrations/0005_equity_snapshots.sql",
    operation: label, detail: String(error && error.message || error).slice(0, 200)
  }, 503);
}

async function handleGet(request, env) {
  const config = requireConfig(env);
  if (config.error) return config.error;
  if (!isSameOrigin(request)) return json({ ok: false, error: "跨站请求已拒绝" }, 403);
  const auth = await readSession(request, env);
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 200));
  try {
    const rows = await env.PAPER_DB.prepare(
      "SELECT snapshot_id, session_id, generation, account_version, state_hash, equity, cash, market_value, unrealized_pnl, realized_pnl, equity_peak, drawdown, mark_quality, marks_json, source, created_at FROM paper_equity_snapshots ORDER BY created_at DESC, snapshot_id DESC LIMIT ?"
    ).bind(limit).all();
    const risk = await buildEquityRiskBasis(env.PAPER_DB);
    const chain = String(url.searchParams.get("verifyChain")) === "1"
      ? await verifyStrategyEventChain(env.PAPER_DB) : null;
    return json({
      ok: true, source: "real-d1", count: (rows.results || []).length,
      snapshots: rows.results || [],
      riskBasis: risk.riskBasis, risk,
      policy: { minVerifiedSnapshots: MIN_VERIFIED_SNAPSHOTS,
                maxSnapshotAgeMs: MAX_SNAPSHOT_AGE_MS,
                unknownMarksNeverGate: true, worstAccountWins: true },
      eventChain: chain
    });
  } catch (error) {
    return tablesMissing(error, "strategy.equity-snapshots.GET");
  }
}

async function handlePost(request, env) {
  const config = requireConfig(env);
  if (config.error) return config.error;
  const raw = await request.text();
  const signed = await verifyServiceSignature(request, env, raw, { db: env.PAPER_DB });
  if (!signed.ok) return signed.response;
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch (_) { /* body is optional */ }
  const strategyId = String(body.strategyId || "portfolio").slice(0, 80) || "portfolio";
  try {
    const result = await collectEquitySnapshots(env.PAPER_DB, env);
    const event = await appendStrategyEvent(env.PAPER_DB, strategyId, "strategy.equity.snapshot", {
      actor: signed.actor, authMethod: signed.authMethod,
      accounts: result.accounts, written: result.written,
      verified: result.verified, unknown: result.unknown,
      failures: result.failures, collectedAt: result.collectedAt
    });
    return json({
      ok: true, ...result,
      signedActor: signed.actor, authMethod: signed.authMethod,
      eventType: event.eventType, eventHash: event.hash,
      stateJsonUntouched: true,
      note: "客户端提交的任何权益数值均被忽略；equity 由服务端从 paper_accounts 与真实 Binance 标记价重算。"
    });
  } catch (error) {
    return tablesMissing(error, "strategy.equity-snapshots.POST");
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "GET") return handleGet(request, env);
  if (request.method === "POST") return handlePost(request, env);
  return json({ ok: false, error: "仅支持 GET / POST" }, 405, { allow: "GET, POST" });
}
