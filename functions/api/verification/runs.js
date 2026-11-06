/**
 * POST /api/verification/runs - Trusted Verification API.
 *
 * The ONLY endpoint allowed to write research_runs / backtest_results /
 * oos_results / verification_receipts. Browser sessions are NOT accepted:
 * either a real GitHub Actions OIDC ID token, or an independently keyed HMAC
 * service signature (timestamp + nonce replay protection) is required.
 *
 * `verified=1` requires: valid seal, pinned repository/commit/engine/strategy
 * hashes, a frozen matching D1 strategy version, real sample thresholds, and
 * non-self-contradicting gate results. Everything else is written as
 * status='failed' / verified=0.
 *
 * `trusted=1` (the release trust anchor) is granted ONLY to a verified
 * GitHub Actions OIDC runner. A local HMAC E2E run can exercise the whole
 * pipeline with verified=1 but gets trusted=0, so the release gate still
 * refuses. This is deliberate: local tests must never open auto-promotion.
 */
import { json, requireConfig } from "../../_lib/paper-ledger.mjs";
import {
  verifyServiceSignature, verifyGithubOidc, sha256Hex
} from "../../_lib/service-auth.mjs";
import {
  parseAndSealBundle, validateBundle, decideEvidence
} from "../../_lib/verification.mjs";
import {
  readTrustAnchors, serverExpectedClaims, workflowAllowed
} from "../../_lib/trust-anchors.mjs";
import { STRATEGY_EVENT_TYPES } from "../../_lib/strategy-events.mjs";

function badRequest(code, errors, extra = {}) {
  return json({ ok: false, code, errors, ...extra }, 422);
}

function fixedPointRatio(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100_000_000) : 0;
}

async function appendVerificationEvent(db, eventType, strategyId, payload, at) {
  if (!STRATEGY_EVENT_TYPES.has(eventType)) return null;
  const last = await db.prepare("SELECT seq, hash FROM strategy_events ORDER BY seq DESC LIMIT 1").first();
  const prevHash = last ? String(last.hash) : null;
  const payloadJson = JSON.stringify(payload);
  const canonical = JSON.stringify({
    strategyId: String(strategyId), eventType, payloadJson, prevHash, at
  });
  const hash = await sha256Hex(canonical);
  return { sql: "INSERT INTO strategy_events (strategy_id, event_type, payload_json, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
           values: [String(strategyId), eventType, payloadJson, prevHash, hash, at] };
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "仅支持 POST" }, 405, { allow: "POST" });
  }
  const config = requireConfig(env);
  if (config.error) return config.error;
  // V4.3 hardening: FAIL CLOSED when the server has not approved an exact
  // trusted workflow AND an exact engine fingerprint. No evidence may be
  // written (verified or trusted) until a human configures both anchors.
  const anchors = readTrustAnchors(env);
  if (!anchors.ok) {
    return json({ ok: false, code: "TRUST_ANCHORS_NOT_CONFIGURED",
                  errors: anchors.errors,
                  error: "服务端尚未固定可信工作流与已批准引擎版本；证据写入保持阻断" }, 503);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 512_000) {
    return json({ ok: false, code: "BODY_TOO_LARGE", error: "证据包过大" }, 413);
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (_) { return json({ ok: false, code: "INVALID_JSON", error: "证据包不是合法 JSON" }, 400); }

  // ---- authenticate BEFORE trusting any bundle content -------------------
  const oidcToken = String(request.headers.get("X-GitHub-OIDC-Token") || "") ||
    (String(request.headers.get("Authorization") || "").startsWith("Bearer eyJ")
      ? String(request.headers.get("Authorization")).slice(7) : "");
  let identity;
  let authError = null;
  if (oidcToken) {
    const provisionalProvenance = (parsed && parsed.provenance) || {};
    // Hardening (A): expected claims are built from SERVER config. The bundle's
    // own `provenance.workflow_ref` is attacker-controlled and is NEVER used
    // as the trust anchor any more.
    const oidc = await verifyGithubOidc(
      oidcToken, env, serverExpectedClaims(env, anchors, provisionalProvenance));
    if (!oidc.ok) {
      authError = json({ ok: false, code: "OIDC_VERIFICATION_FAILED", error: oidc.error }, 401);
    } else if (!workflowAllowed(oidc.workflowRef, anchors)) {
      authError = json({ ok: false, code: "OIDC_WORKFLOW_NOT_ALLOWED",
                         error: "OIDC 工作流不在服务端可信白名单内" }, 401);
    } else {
      identity = {
        authMethod: "github-actions-oidc", trusted: 1,
        repository: oidc.repository, commitSha: oidc.commitSha,
        workflowRef: oidc.workflowRef, actor: oidc.actor,
        workflowRunId: oidc.workflowRunId
      };
    }
  } else {
    const hmac = await verifyServiceSignature(request, env, raw, { db: env.PAPER_DB });
    if (!hmac.ok) authError = hmac.response;
    else identity = { authMethod: "hmac-service", trusted: 0, actor: hmac.actor };
  }
  if (authError) return authError;

  // ---- verify the bundle seal and use the canonical payload as truth -----
  const sealed = await parseAndSealBundle(parsed);
  const at = new Date().toISOString();
  if (!sealed.ok) {
    const evt = await appendVerificationEvent(env.PAPER_DB, "strategy.verification.rejected",
      "verification", { errors: sealed.errors, authMethod: identity.authMethod, at }, at);
    if (evt) await env.PAPER_DB.prepare(evt.sql).bind(...evt.values).run();
    return badRequest("BUNDLE_SEAL_INVALID", sealed.errors);
  }
  const core = sealed.core;
  const validation = validateBundle(core, identity);
  if (!validation.ok) {
    const evt = await appendVerificationEvent(env.PAPER_DB, "strategy.verification.rejected",
      "verification", { errors: validation.errors, authMethod: identity.authMethod,
                        bundleSha256: sealed.declared, at }, at);
    if (evt) await env.PAPER_DB.prepare(evt.sql).bind(...evt.values).run();
    return badRequest("BUNDLE_VALIDATION_FAILED", validation.errors);
  }

  // ---- pin every run to the authoritative D1 strategy version ------------
  const db = env.PAPER_DB;
  const decisions = [];
  const statements = [];
  try {
    for (const run of core.runs) {
      const versionRow = await db.prepare(
        "SELECT strategy_id, version, source_sha256, frozen, lifecycle FROM strategy_versions WHERE strategy_id = ?"
      ).bind(run.strategy_id).first();
      const decision = decideEvidence(run, core, identity, versionRow, validation.ok, anchors);
      decisions.push({ runId: run.run_id, strategyId: run.strategy_id, symbol: run.symbol, ...decision });
      const p = core.provenance;
      const note = JSON.stringify({
        runner: p.runner, gitCommitSha: p.git_commit_sha || null,
        workflowRunId: p.workflow_run_id || null, bundleSha256: sealed.declared,
        inputSha256: run.input_sha256, trusted: decision.trusted,
        authMethod: identity.authMethod, reasons: decision.reasons
      }).slice(0, 1800);

      statements.push(db.prepare(
        "INSERT OR REPLACE INTO research_runs (run_id, strategy_id, strategy_version, source, status, symbols_json, window_from, window_to, input_sha256, engine_sha256, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(run.run_id, run.strategy_id, run.strategy_version, "python-backtest-engine",
             decision.status, JSON.stringify([run.symbol]), run.window_from, run.window_to,
             run.input_sha256, p.engine_sha256, note, at));

      const m = run.metrics || {};
      const ins = m.insample || {};
      const metricsJson = JSON.stringify({
        ...m,
        winRate: ins.win_rate ?? 0,
        avgWinPct: ins.avg_win ?? 0,
        avgLossPct: Math.abs(ins.avg_loss ?? 0)
      }).slice(0, 120000);
      statements.push(db.prepare(
        "INSERT OR REPLACE INTO backtest_results (result_id, run_id, strategy_id, sample_count, metrics_json, strategy_pass, verified, verification_note, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(run.run_id + ":bt", run.run_id, run.strategy_id, Number(m.sample_count) || 0,
             metricsJson, Number(run.gates.strategy_pass) || 0, decision.verified, note, at));

      const oos = m.oos || {};
      statements.push(db.prepare(
        "INSERT OR REPLACE INTO oos_results (result_id, run_id, strategy_id, folds, oos_trades, oos_win_rate, oos_profit_factor, oos_pass, verified, verification_note, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(run.run_id + ":oos", run.run_id, run.strategy_id, Number(run.folds) || 0,
             Number(m.oos_trades) || 0, fixedPointRatio(oos.win_rate),
             fixedPointRatio(oos.profit_factor), Number(run.gates.oos_pass) || 0,
             decision.verified, note, at));

      statements.push(db.prepare(
        "INSERT OR REPLACE INTO verification_receipts (run_id, auth_method, trusted, repository, workflow_ref, commit_sha, workflow_run_id, bundle_sha256, engine_sha256, strategy_source_sha256, input_sha256, actor, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(run.run_id, identity.authMethod, decision.trusted,
             p.repository || null, p.workflow_ref || null, p.git_commit_sha || null,
             p.workflow_run_id || identity.workflowRunId || null,
             sealed.declared, p.engine_sha256, p.strategy_source_sha256,
             run.input_sha256, identity.actor || null, at));
    }

    const evt = await appendVerificationEvent(db, "strategy.verification.accepted", "verification", {
      bundleSha256: sealed.declared, authMethod: identity.authMethod,
      trusted: identity.trusted, runner: core.provenance.runner,
      runs: decisions.map((d) => ({ runId: d.runId, verified: d.verified,
                                    trusted: d.trusted, status: d.status, reasons: d.reasons })),
      at
    }, at);
    if (evt) statements.push(db.prepare(evt.sql).bind(...evt.values));

    // ONE atomic D1 batch: research_runs + backtest_results + oos_results +
    // verification_receipts + evidence-chain event either all land or none.
    await db.batch(statements);
  } catch (error) {
    return json({
      ok: false, code: "VERIFICATION_PERSISTENCE_FAILED",
      error: "证据写入失败（请确认已应用 migrations/0005_equity_snapshots.sql）",
      detail: String(error && error.message || error).slice(0, 300)
    }, 503);
  }

  return json({
    ok: true, source: "real-d1", bundleSha256: sealed.declared,
    authMethod: identity.authMethod,
    trusted: identity.trusted,
    runner: core.provenance.runner,
    gitCommitSha: core.provenance.git_commit_sha || null,
    runs: decisions,
    verifiedRuns: decisions.filter((d) => d.verified === 1).length,
    trustedRuns: decisions.filter((d) => d.trusted === 1).length,
    failedRuns: decisions.filter((d) => d.verified === 0).length,
    atomicBatchStatements: statements.length,
    note: "trusted=1 仅由真实 GitHub Actions OIDC Runner 产生；本地 HMAC 运行即便 verified=1 也不得放行策略。"
  });
}
