/**
 * POST /api/agents/research - six-role AI research, SERVER-TRUSTED ONLY.
 *
 * V4.3 security fix. The previous implementation:
 *   1. accepted requests with NO Origin header (Origin check was optional),
 *   2. read the Provider API key straight from the browser request body,
 *   3. labelled the market snapshot "browser-request-untrusted" yet still
 *      fed it into the research pipeline.
 *
 * Now the ONLY accepted caller is a signed service-to-service request from the
 * JEV Provider Center bridge (HMAC + timestamp + nonce replay protection, or a
 * GitHub Actions OIDC token). Browser sessions, cookies and Origin headers are
 * never sufficient. Browser-supplied credential fields are rejected outright.
 *
 * Credentials arrive in `serviceCredentials` on the signed request, are used
 * only in memory, are stripped from the body BEFORE the orchestrator runs, and
 * can therefore never reach paper_events, strategy_events, logs or responses.
 * No key is stored in NR: JEV remains the single credential authority.
 *
 * Until the JEV bridge is connected, this endpoint returns an explicit
 * PROVIDER_BRIDGE_NOT_CONNECTED / unsigned rejection, never a misleading
 * "check your API key" error and never a fabricated research result.
 */
import { handleAgentResearch } from "../../_lib/agent-orchestrator.mjs";
import { json, requireConfig } from "../../_lib/paper-ledger.mjs";
import {
  verifyServiceSignature, verifyGithubOidc
} from "../../_lib/service-auth.mjs";
import { appendStrategyEvent } from "../../_lib/strategy-events.mjs";

const FORBIDDEN_CLIENT_FIELDS = [
  "apiKey", "api_key", "region", "workspaceId", "token", "secret", "authorization"
];

export async function handleResearchRequest(request, env, handler = handleAgentResearch) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "仅支持 POST" }, 405, { allow: "POST" });
  }
  const config = requireConfig(env);
  if (config.error) return config.error;
  const raw = await request.text();

  // (1) Origin is NEVER an authentication mechanism here. Require a real
  // service identity before even parsing the body.
  const oidcToken = String(request.headers.get("X-GitHub-OIDC-Token") || "");
  let identity;
  if (oidcToken) {
    const oidc = await verifyGithubOidc(oidcToken, env, {});
    if (!oidc.ok) {
      return json({ ok: false, code: "OIDC_VERIFICATION_FAILED", error: oidc.error }, 401);
    }
    identity = { authMethod: "github-actions-oidc", actor: oidc.actor };
  } else {
    const signed = await verifyServiceSignature(request, env, raw, { db: env.PAPER_DB });
    if (!signed.ok) return signed.response;
    identity = { authMethod: "hmac-service", actor: signed.actor };
  }

  let body;
  try {
    body = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
  } catch (_) {
    return json({ ok: false, code: "INVALID_JSON", error: "JSON 请求体无效" }, 400);
  }

  // (2) A browser must NEVER submit a Provider key in any form.
  for (const field of FORBIDDEN_CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      return json({
        ok: false, code: "BROWSER_CREDENTIALS_FORBIDDEN",
        error: "禁止浏览器直接提交 Provider API Key / 凭据；请通过 JEV Provider Center 服务端桥接"
      }, 400);
    }
  }

  // (3) Credentials are supplied by the trusted bridge only, for this single
  // in-memory call. No persistence, no second key store in NR.
  const creds = body.serviceCredentials && typeof body.serviceCredentials === "object"
    ? body.serviceCredentials : null;
  if (!creds || typeof creds.apiKey !== "string" || creds.apiKey.length < 8) {
    return json({
      ok: false, code: "PROVIDER_BRIDGE_NOT_CONNECTED", blocked: true,
      error: "JEV Provider Center 桥接尚未接通或未提供服务端凭据；六角色真实推理保持 BLOCKED"
    }, 503);
  }

  // (4) Strip every credential before handing the body to the orchestrator,
  // so it cannot leak into paper_events / strategy_events / responses.
  const sanitized = { ...body };
  delete sanitized.serviceCredentials;
  const trustedRequest = new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": new URL(request.url).origin },
    body: JSON.stringify(sanitized)
  });

  const at = new Date().toISOString();
  const response = await handler(trustedRequest, undefined, env, {
    snapshotSource: "signed-service-request",
    providerCredentials: creds,
    actor: identity.actor,
    authMethod: identity.authMethod
  });

  // (5) Independent, replayable audit event. Contains metadata ONLY.
  try {
    let result = {};
    try { result = await response.clone().json(); } catch (_) { /* ignore */ }
    await appendStrategyEvent(env.PAPER_DB, "six-role-research", "agent.run.trusted", {
      runId: result.runId || null,
      ok: result.ok === true,
      actor: identity.actor,
      authMethod: identity.authMethod,
      provider: String(sanitized.provider || ""),
      model: String(sanitized.model || ""),
      snapshotSource: "signed-service-request",
      snapshotHash: result.snapshotHash || null,
      autoExecution: false,
      at
    });
  } catch (_) { /* audit failure must not fabricate a research result */ }

  return response;
}

export async function onRequest(context) {
  return handleResearchRequest(context.request, context.env);
}
