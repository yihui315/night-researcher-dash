// Deterministic, network-free mock for the AI layer (OFFLINE environment).
//
// Returns a fetchImpl compatible with ai-core's handleAiChat: it inspects the outgoing
// request body, finds which AGENT_ID the pipeline asked for, and answers with the canned
// structured JSON you supply. Because it still flows through handleAiChat, all real request
// validation (provider/api-key/region/message bounds) is exercised — only the upstream HTTP
// call is faked. Swap in a real fetchImpl later for live runs.

// roleResponses: { SPOTTER: <object|string>, PRIOR: ..., EDGE: ..., CLOSER: ..., default: ... }
// options.usage: usage object returned for every role.
export function mockFetchImpl(roleResponses = {}, options = {}) {
  const map = roleResponses;
  const usage = options.usage || { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 };
  const apiKey = options.apiKey || "sk-mock-0000000000001";

  return async function fetchImpl(_url, init) {
    const raw = (init && init.body) || "{}";
    let body;
    try {
      body = JSON.parse(raw);
    } catch (_) {
      body = {};
    }
    // ai-core prepends a system prompt, so scan the entire request for AGENT_ID.
    const match = raw.match(/AGENT_ID:\s*([A-Z]+)/);
    const role = match ? match[1] : null;
    const value = Object.prototype.hasOwnProperty.call(map, role) ? map[role] : map.default;

    if (value === undefined || value === null) {
      return new Response(
        JSON.stringify({ ok: false, error: "mock 未提供角色响应: " + role }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }
    const model = body.model || "mock-model";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    // Return the UPSTREAM provider shape (OpenAI-compatible) — handleAiChat extracts text
    // from choices[0].message.content and then re-wraps it in its own {ok,text,usage} envelope.
    return new Response(
      JSON.stringify({
        id: "mock-" + (role || "default"),
        model,
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
}

// Convenience: build a model caller bound to the mock for a given provider preset.
// (createModelCaller lives in adapter.mjs; kept separate to avoid an ESM require cycle.)
// Usage: const caller = mockModelCaller({ SPOTTER: {...}, ... });
export function mockModelCaller(roleResponses, options = {}) {
  const apiKey = options.apiKey || "sk-mock-0000000000001";
  return {
    provider: options.provider || "qwen",
    model: (options.provider === "minimax" ? "MiniMax-M3" : "qwen3-coder-next"),
    callModel: async (messages) => {
      const fetchImpl = mockFetchImpl(roleResponses, { ...options, apiKey });
      const request = new Request("https://night-researcher.local/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://night-researcher.local" },
        body: JSON.stringify({
          provider: options.provider || "qwen",
          model: (options.provider === "minimax" ? "MiniMax-M3" : "qwen3-coder-next"),
          apiKey,
          region: options.region || "virginia",
          workspaceId: options.workspaceId || "nr-research-001",
          maxTokens: 2048,
          messages
        })
      });
      const response = await (async () => {
        // route through the real ai-core handler so validation still runs
        const { handleAiChat } = await import("../ai-core.mjs");
        return handleAiChat(request, fetchImpl);
      })();
      const data = await response.json();
      if (!data.ok) {
        const error = new Error(data.error || "AI 调用失败");
        error.code = data.code || null;
        throw error;
      }
      return { text: data.text, model: data.model, usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    }
  };
}
