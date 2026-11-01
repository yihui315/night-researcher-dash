const REGION_HOSTS = Object.freeze({
  singapore: "ap-southeast-1",
  beijing: "cn-beijing",
  tokyo: "ap-northeast-1",
  frankfurt: "eu-central-1",
  virginia: "us-east-1"
});

const MINIMAX_ENDPOINTS = Object.freeze({
  china: "https://api.minimaxi.com/v1/chat/completions",
  global: "https://api.minimax.io/v1/chat/completions"
});
const MINIMAX_MODEL = "MiniMax-M3";
const QWEN_MODELS = Object.freeze(["qwen3.7-plus", "qwen3.8-max", "qwen3.6-plus"]);
const DEFAULT_QWEN_MODEL = "qwen3.7-plus";

const SYSTEM_PROMPT = [
  "你是 Night Researcher 的量化研究副驾驶。",
  "只做研究、数据解释、策略假设、模拟交易复盘和风险分析；绝不发送真实订单，不连接钱包，不要求用户提供交易所交易密钥。",
  "严格区分已观测事实、模型推断和待验证假设。缺失数据必须标记为未知，不得编造价格、盘口、成交或链上数据。",
  "任何策略假设必须说明触发条件、退出/失效条件、手续费与滑点假设、最大风险、样本外验证方法。",
  "不得保证盈利，不得把回测收益表述为未来收益。优先建议可证伪的纸面模拟实验，不把研究输出当作交易指令。",
  "不输出内部推理过程，只提供可核查的结论、简明理由和风险说明。回答使用中文，结构清楚、结论可执行、风险优先。"
].join("\n");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff"
    }
  });
}

function textContent(content) {
  let value = "";
  if (typeof content === "string") value = content;
  else if (Array.isArray(content)) {
    value = content.filter(part => part && part.type === "text" && typeof part.text === "string")
      .map(part => part.text).join("\n");
  }
  return value.replace(/<think>[\\s\\S]*?<\\/think>/gi, "").trim();
}

export async function handleAiChat(request, fetchImpl = fetch) {
  if (request.method !== "POST") return json({ error: "仅支持 POST" }, 405);

  const origin = request.headers.get("Origin");
  const requestOrigin = new URL(request.url).origin;
  if (origin && origin !== requestOrigin) return json({ error: "跨站请求已拒绝" }, 403);

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "请求必须使用 application/json" }, 415);
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 40000) return json({ error: "请求内容过大" }, 413);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "JSON 请求体无效" }, 400);
  }

  const provider = String(body.provider || "");
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!["minimax", "qwen"].includes(provider)) return json({ error: "不支持的 AI 服务商" }, 400);
  if (apiKey.length < 12 || apiKey.length > 500) return json({ error: "请检查 API Key" }, 400);

  let endpoint;
  let model;
  if (provider === "minimax") {
    model = MINIMAX_MODEL;
    if (body.model && body.model !== model) return json({ error: "模型标识不匹配" }, 400);
    const minimaxRegion = String(body.region || "china");
    endpoint = MINIMAX_ENDPOINTS[minimaxRegion];
    if (!endpoint) return json({ error: "请选择 MiniMax API Key 所属区域" }, 400);
  } else {
    model = body.model ? String(body.model) : DEFAULT_QWEN_MODEL;
    if (!QWEN_MODELS.includes(model)) return json({ error: "当前 Qwen 模型未开放在此接口白名单中" }, 400);
    if (apiKey.startsWith("sk-sp-")) {
      return json({
        error: "检测到 Qwen Coding Plan 套餐密钥（sk-sp-）。该密钥仅限 Qwen Code 等交互式编程工具，不可用于本应用后端。请改用 Model Studio 通用 API Key（sk-，按量计费）。"
      }, 400);
    }
    if (!apiKey.startsWith("sk-")) return json({ error: "请输入 Model Studio 通用 API Key（sk- 开头）" }, 400);
    const regionHost = REGION_HOSTS[String(body.region || "")];
    const workspaceId = String(body.workspaceId || "");
    if (!regionHost) return json({ error: "请选择有效的 Model Studio 区域" }, 400);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$/.test(workspaceId)) {
      return json({ error: "Workspace ID 格式无效" }, 400);
    }
    endpoint = `https://${workspaceId}.${regionHost}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
  }

  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 12) {
    return json({ error: "消息数量必须为 1–12 条" }, 400);
  }
  const messages = [];
  let totalChars = 0;
  for (const message of body.messages) {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      return json({ error: "消息格式无效" }, 400);
    }
    const content = message.content.trim();
    if (!content || content.length > 12000) return json({ error: "单条消息为空或超过 12,000 字符" }, 400);
    totalChars += content.length;
    messages.push({ role: message.role, content });
  }
  if (totalChars > 24000 || !messages.some(message => message.role === "user")) {
    return json({ error: "消息总长度超限或缺少用户问题" }, 400);
  }

  try {
    const upstream = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        temperature: 0.2,
        stream: false,
        ...(provider === "minimax"
          ? { max_completion_tokens: 1200, thinking: { type: "adaptive" }, reasoning_split: true }
          : { max_tokens: 1200 })
      }),
      signal: AbortSignal.timeout(45000)
    });

    let data;
    try {
      data = await upstream.json();
    } catch (_) {
      return json({ error: "AI 服务商返回了无法解析的响应" }, 502);
    }

    if (!upstream.ok) {
      if (upstream.status === 401 || upstream.status === 403) {
        return json({ error: "上游认证失败：请核对 API Key、区域和 Workspace ID" }, 502);
      }
      if (upstream.status === 429) return json({ error: "上游请求频率或额度已达到限制，请稍后重试" }, 429);
      return json({ error: `AI 服务商请求失败（HTTP ${upstream.status}）` }, 502);
    }

    const content = textContent(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
    if (!content) return json({ error: "模型响应中没有可显示的文本内容" }, 502);

    return json({
      ok: true,
      provider,
      model,
      text: content,
      usage: data.usage || null
    });
  } catch (error) {
    const message = error && error.name === "TimeoutError" ? "AI 请求超时，请稍后重试" : "无法连接 AI 服务商，请检查网络或稍后重试";
    return json({ error: message }, 502);
  }
}
