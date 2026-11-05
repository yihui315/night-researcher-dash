/**
 * JEV V4.3 / §3 - independent Cloudflare Scheduled Worker.
 *
 * Runs every minute, reads real paper accounts, marks every open position with
 * REAL Binance prices, and appends an immutable mark-to-market equity snapshot.
 * It NEVER mutates paper_accounts.state_json / state_hash / version and NEVER
 * writes paper_server_events, so the trading replay chain stays untouched.
 *
 * Deployment is a separate, MANUALLY APPROVED step. This worker is NOT part of
 * the Pages Functions bundle and is never deployed by this branch.
 */
import { collectEquitySnapshots } from "../../functions/_lib/equity-snapshot.mjs";
import { appendStrategyEvent } from "../../functions/_lib/strategy-events.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

async function collect(env, source) {
  if (!env || !env.PAPER_DB || typeof env.PAPER_DB.prepare !== "function") {
    return { ok: false, code: "PAPER_DB_NOT_BOUND", source };
  }
  const result = await collectEquitySnapshots(env.PAPER_DB, env);
  const event = await appendStrategyEvent(env.PAPER_DB, "portfolio", "strategy.equity.snapshot", {
    actor: "scheduled-worker", source, accounts: result.accounts,
    written: result.written, verified: result.verified,
    unknown: result.unknown, failures: result.failures,
    collectedAt: result.collectedAt
  });
  return { ok: true, ...result, eventHash: event.hash, stateJsonUntouched: true };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(collect(env, "cloudflare-scheduled"));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, worker: "jev-equity-snapshot", cron: "* * * * *",
                    d1Bound: !!(env && env.PAPER_DB) });
    }
    // wrangler dev --test-scheduled posts here; also usable for local E2E.
    if (request.method === "POST" && (url.pathname === "/__scheduled" || url.pathname === "/collect")) {
      try {
        const result = await collect(env, "local-test-scheduled");
        return json(result, result.ok ? 200 : 503);
      } catch (error) {
        return json({ ok: false, code: "SNAPSHOT_COLLECTION_FAILED",
                      error: String(error && error.message || error).slice(0, 200) }, 503);
      }
    }
    return json({ ok: false, error: "not found" }, 404);
  }
};
