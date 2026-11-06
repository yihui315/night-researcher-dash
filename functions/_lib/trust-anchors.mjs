/**
 * JEV V4.3 security hardening - SERVER-SIDE trust anchors.
 *
 * Two anchors were previously missing from the trusted verification boundary:
 *
 *   A. The trusted GitHub Actions workflow was pinned by the CLIENT: the API
 *      passed `provenance.workflow_ref` (attacker-controlled bundle content)
 *      into `verifyGithubOidc(..., expected.workflowRef)`. Any workflow in the
 *      allowed repository/ref could therefore mint its own "trusted" evidence.
 *      Here the allowed workflow ref is read ONLY from server configuration
 *      (NR_OIDC_ALLOWED_WORKFLOW_REF) and must match claims.job_workflow_ref.
 *
 *   B. `engine_sha256` was only format-checked (64 hex chars) and recorded as
 *      a column. It never participated in any decision. Here an approved
 *      engine fingerprint set (NR_APPROVED_ENGINE_SHA256) is REQUIRED, and a
 *      bundle using any other engine can never be written as verified/trusted.
 *
 * Design rules:
 *   - FAIL CLOSED. Missing / malformed / empty anchor config => no trusted
 *     evidence at all. There is no implicit "local" or "test" bypass.
 *   - Pure functions only, so they can be independently unit tested without
 *     D1, network, or secrets.
 *   - No secret material is read here; these are PUBLIC identity pins.
 */

export const WORKFLOW_REF_RE = /^[A-Za-z0-9._\-/]+\/\.github\/workflows\/[A-Za-z0-9._\-]+\.ya?ml@[A-Za-z0-9._\-/]+$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

/** Split a comma-separated config value, trim, drop empties. */
function splitList(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Read and validate the server-side anchors. `env` is the Worker environment,
 * NEVER a request body or bundle provenance.
 */
export function readTrustAnchors(env) {
  const errors = [];
  const workflowRefs = splitList(env && env.NR_OIDC_ALLOWED_WORKFLOW_REF);
  const engineSha256 = splitList(env && env.NR_APPROVED_ENGINE_SHA256)
    .map((s) => s.toLowerCase());

  if (!workflowRefs.length) {
    errors.push("NR_OIDC_ALLOWED_WORKFLOW_REF_NOT_CONFIGURED");
  } else {
    for (const ref of workflowRefs) {
      if (!WORKFLOW_REF_RE.test(ref)) {
        errors.push("NR_OIDC_ALLOWED_WORKFLOW_REF_MALFORMED:" + ref.slice(0, 120));
      }
    }
  }
  if (!engineSha256.length) {
    errors.push("NR_APPROVED_ENGINE_SHA256_NOT_CONFIGURED");
  } else {
    for (const sha of engineSha256) {
      if (!SHA256_RE.test(sha)) {
        errors.push("NR_APPROVED_ENGINE_SHA256_MALFORMED:" + sha.slice(0, 80));
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    workflowRefs,
    engineSha256: new Set(engineSha256),
  };
}

/** Is this OIDC workflow ref one the SERVER explicitly trusts? */
export function workflowAllowed(workflowRef, anchors) {
  if (!anchors || !anchors.ok || !anchors.workflowRefs.length) return false;
  return anchors.workflowRefs.includes(String(workflowRef || ""));
}

/** Is this engine fingerprint one the SERVER explicitly approved? */
export function engineApproved(engineSha256, anchors) {
  if (!anchors || !anchors.ok || !anchors.engineSha256.size) return false;
  return anchors.engineSha256.has(String(engineSha256 || "").toLowerCase());
}

/**
 * Build the `expected` object for verifyGithubOidc using SERVER anchors only.
 * Client-supplied provenance values are deliberately ignored for the workflow
 * pin; repository / commit sha remain pinned to the (untrusted) bundle only as
 * a cross-check AFTER the signed OIDC claims have been verified.
 */
export function serverExpectedClaims(env, anchors, provenance = {}) {
  const expected = {
    ...(env && env.NR_OIDC_REPOSITORY ? { repository: env.NR_OIDC_REPOSITORY } : {}),
    ...(provenance && provenance.git_commit_sha
      ? { commitSha: provenance.git_commit_sha } : {}),
  };
  // With exactly one trusted workflow we can also pin the claim directly.
  // With several, verifyGithubOidc's server allowlist is authoritative.
  // In BOTH cases the client's provenance.workflow_ref is never used.
  if (anchors && anchors.workflowRefs.length === 1) {
    expected.workflowRef = anchors.workflowRefs[0];
  }
  return expected;
}

export const __test = {
  readTrustAnchors, workflowAllowed, engineApproved, serverExpectedClaims,
  WORKFLOW_REF_RE, SHA256_RE,
};
