// Thin adapter around the existing AI orchestration layer (functions/_lib/ai-core.mjs).
//
// We REUSE handleAiChat (the real provider/model-call helper) rather than building a second
// agent system. The adapter wraps it so the pipeline can issue a model call per role and get
// back a normalized { text, model, usage } object. In production (online) you pass the default
// global fetch; OFFLINE / tests pass a mock fetchImpl so no network is touched.
//
// This keeps the real request validation (provider allowlist, api-key shape, region/workspace,
// message bounds) intact while allowing deterministic, network-free runs.

import { handleAiChat } from "../ai-core.mjs";

// Sensible default presets so callers don't have to know provider-specific quirks.
export const PROVIDER_PRESETS = Object.freeze({
  qwen: { provider: "qwen", model: "qwen3-coder-next", region: "virginia", workspaceId: "nr-research-001" },
  minimax: { provider: "minimax", model: "MiniMax-M3", region: "china" }
});

// Build a model caller bound to one provider/model identity.
// config: { provider, model, apiKey, region, workspaceId, maxTokens, fetchImpl }
// Returns an object: { provider, model, callModel(messages) -> Promise<{text, model, usage}> }
export function createModelCaller(config = {}) {
  const preset = PROVIDER_PRESETS[config.provider] || {};
  const provider = config.provider || preset.provider;
  const model = config.model || preset.model;
  const region = config.region || preset.region;
  const workspaceId = config.workspaceId || preset.workspaceId;
  const maxTokens = config.maxTokens == null ? 2048 : config.maxTokens;
  const fetchImpl = config.fetchImpl || globalThis.fetch;

  if (!["minimax", "qwen"].includes(provider)) {
    throw new Error("不支持的 AI 服务商: " + provider);
  }

  async function callModel(messages) {
    const request = new Request("https://night-researcher.local/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://night-researcher.local" },
      body: JSON.stringify({ provider, model, apiKey: config.apiKey, region, workspaceId, maxTokens, messages })
    });
    const response = await handleAiChat(request, fetchImpl);
    const data = await response.json();
    if (!data.ok) {
      const error = new Error(data.error || "AI 调用失败");
      error.code = data.code || null;
      error.status = response.status;
      throw error;
    }
    return {
      text: data.text,
      model: data.model,
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
  }

  return { provider, model, callModel };
}

// Helper: extract a single JSON object from model text (strips ```json fences, grabs first {...}).
// Mirrors the parser used by agent-orchestrator so behaviour is identical.
export function parseAgentObject(text) {
  const clean = String(text || "").replace(/```(?:json)?/gi, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(clean.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}
