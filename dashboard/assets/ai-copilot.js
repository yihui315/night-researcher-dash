/* Night Researcher AI Copilot — keys and conversation remain in page memory only. */
"use strict";
(function () {
  const $ = id => document.getElementById(id);
  const conversation = [];
  let busy = false;

  function logResearchEvent(eventType, payload) {
    const append = window.NRTradingAppendLedgerEvent;
    if (typeof append !== "function") return;
    Promise.resolve(append(eventType, payload || {})).catch(() => {});
  }

  function setStatus(text, kind) {
    const el = $("aiStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "small-pill ai-status " + (kind || "");
  }

  function appendMessage(role, text) {
    const host = $("aiOutput");
    const item = document.createElement("div");
    item.className = "ai-message " + role;
    const label = document.createElement("b");
    label.textContent = role === "assistant" ? "AI 研究员" : "你";
    const body = document.createElement("div");
    body.className = "ai-message-body";
    body.textContent = text;
    item.append(label, body);
    host.appendChild(item);
    host.scrollTop = host.scrollHeight;
  }

  function providerFields() {
    const provider = $("aiProvider").value;
    $("minimaxFields").classList.toggle("hidden", provider !== "minimax");
    $("qwenFields").classList.toggle("hidden", provider !== "qwen");
  }

  function tableRows(selector, maxRows) {
    return Array.from(document.querySelectorAll(selector)).slice(0, maxRows || 8)
      .map(row => Array.from(row.children).map(cell => cell.textContent.trim()));
  }

  function marketSnapshot() {
    const symbols = ["BTCUSDT", "ETHUSDT", "ORDIUSDT", "1000SATSUSDT"];
    const tickers = {};
    symbols.forEach(symbol => {
      tickers[symbol] = {
        price: ($("ticker-" + symbol) || {}).textContent || "未知",
        change24h: ($("change-" + symbol) || {}).textContent || "未知"
      };
    });
    return {
      capturedAt: new Date().toISOString(),
      selectedSymbol: $("symbolSelect") ? $("symbolSelect").value : "未知",
      interval: document.querySelector("[data-interval].active")?.dataset.interval || "未知",
      selectedPrice: $("selectedPrice")?.textContent || "未知",
      selectedChange24h: $("selectedChange")?.textContent || "未知",
      tickers,
      paperAccount: {
        equity: $("equityValue")?.textContent || "未知",
        dailyPnl: $("dailyPnl")?.textContent || "未知",
        realizedPnl: $("realizedPnl")?.textContent || "未知",
        unrealizedPnl: $("unrealizedPnl")?.textContent || "未知",
        drawdown: $("drawdownValue")?.textContent || "未知",
        exposure: $("exposureValue")?.textContent || "未知",
        availableCash: $("availableCash")?.textContent || "未知"
      },
      strategyGate: $("gateSummary")?.textContent || "未知",
      strategyRows: tableRows("#gateRows .gate-row", 12),
      positions: tableRows("#positionsBody tr", 8),
      openOrders: tableRows("#openOrdersBody tr", 8),
      recentPaperTrades: tableRows("#tradesBody tr", 10),
      orderBook: {
        asks: tableRows("#askRows .book-row", 5),
        bids: tableRows("#bidRows .book-row", 5),
        spread: $("spreadValue")?.textContent || "未知"
      },
      structuredMarket: window.NRTradingGetSnapshot ? window.NRTradingGetSnapshot() : null,
      strategyMetrics: null,
      safety: "仅模拟账户；无真实交易密钥、无钱包、无真实订单权限"
    };
  }

  function currentConfig() {
    const provider = $("aiProvider").value;
    if (provider === "minimax") {
      return {
        provider,
        model: "MiniMax-M3",
        region: $("minimaxRegion").value,
        apiKey: $("minimaxApiKey").value.trim()
      };
    }
    return {
      provider,
      model: $("qwenModel").value,
      apiKey: $("qwenApiKey").value.trim(),
      region: $("qwenRegion").value,
      workspaceId: $("qwenWorkspaceId").value.trim()
    };
  }

  async function run(mode) {
    if (busy) return;
    const config = currentConfig();
    if (!config.apiKey) {
      setStatus("请先输入 API Key", "error");
      return;
    }
    const prompt = mode === "test" ? "请只回复 AI_READY，不要执行其他任务。" : $("aiPrompt").value.trim();
    if (!prompt) {
      setStatus("请输入研究问题", "error");
      return;
    }
    if (config.provider === "qwen" && !config.workspaceId) {
      setStatus("请填写 Workspace ID", "error");
      return;
    }

    const contextText = mode === "test" ? "" : "\n\n当前网页快照（只代表此刻页面可见数据；缺项按未知处理）：\n" + JSON.stringify(marketSnapshot(), null, 2);
    const userMessage = prompt + contextText;
    const messages = mode === "test"
      ? [{ role: "user", content: userMessage }]
      : [...conversation.slice(-10), { role: "user", content: userMessage }];

    busy = true;
    $("aiTest").disabled = true;
    $("aiRun").disabled = true;
    setStatus(mode === "test" ? "正在验证连接…" : "AI 正在研究…", "pending");
    if (mode !== "test") appendMessage("user", prompt);

    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          region: config.region,
          workspaceId: config.workspaceId,
          messages
        })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "AI 请求失败");
      if (mode === "test") {
        setStatus("连接成功 · " + data.model, "success");
        appendMessage("assistant", "AI_READY · " + data.model + " 已响应。现在可以运行研究分析。");
      } else {
        conversation.push({ role: "user", content: userMessage }, { role: "assistant", content: data.text });
        if (conversation.length > 12) conversation.splice(0, conversation.length - 12);
        appendMessage("assistant", data.text);
        setStatus("运行正常 · " + data.model, "success");
      }
    } catch (error) {
      setStatus("连接失败", "error");
      appendMessage("assistant", "请求未完成：" + (error.message || "未知错误"));
    } finally {
      busy = false;
      $("aiTest").disabled = false;
      $("aiRun").disabled = false;
    }
  }

  async function runTeam() {
    if (busy) return;
    const config = currentConfig();
    if (!config.apiKey) { setStatus("请先输入 API Key", "error"); return; }
    if (config.provider === "qwen" && !config.workspaceId) { setStatus("请填写 Workspace ID", "error"); return; }
    busy = true;
    const runId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    const snapshot = marketSnapshot();
    const startedAt = new Date().toISOString();
    logResearchEvent("agent.run.started", { runId, provider: config.provider, model: config.model, promptVersion: "nr-agent-research-v1", startedAt, snapshot });
    $("aiTeamRun").disabled = true;
    $("aiTest").disabled = true;
    $("aiRun").disabled = true;
    $("aiTeamStatus").textContent = "六角色运行中…";
    $("aiTeamStatus").className = "small-pill ai-status pending";
    $("aiTeamOutput").textContent = "正在依次运行 SPOTTER → PRIOR → EDGE → KELLY → TAKER → CLOSER。";
    try {
      const response = await fetch("/api/agents/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          runId, provider: config.provider, model: config.model, apiKey: config.apiKey,
          region: config.region, workspaceId: config.workspaceId, snapshot
        })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        logResearchEvent("agent.run.failed", { runId: data.runId || runId, snapshotHash: data.snapshotHash || null, provider: config.provider, model: config.model, failedAgent: data.agent || null, error: data.error || "研究请求失败", providerErrorCode: data.providerErrorCode || null, finishReason: data.finishReason || null, partial: data.partial || {}, completedAt: new Date().toISOString() });
        $("aiTeamStatus").textContent = "流程未完成";
        $("aiTeamStatus").className = "small-pill ai-status error";
        $("aiTeamOutput").textContent = "流程中止，未生成订单。";
        appendMessage("assistant", "六 Agent 流程中止：" + (data.error || "请求失败") + (data.agent ? " · 阻塞角色 " + data.agent : "") + (data.providerErrorCode ? " · 错误码 " + data.providerErrorCode : "") + (data.finishReason ? " · finish_reason " + data.finishReason : ""));
        if (data.partial) appendMessage("assistant", "已完成的角色结果：\n" + JSON.stringify(data.partial, null, 2));
        return;
      }
      logResearchEvent("agent.run.completed", { runId: data.runId || runId, snapshotHash: data.snapshotHash || null, provider: data.provider || config.provider, model: data.requestedModel || config.model, promptVersion: data.promptVersion || "nr-agent-research-v1", startedAt: data.startedAt || startedAt, completedAt: data.completedAt || new Date().toISOString(), durationMs: data.durationMs || null, usage: data.usage || {}, outputs: data.outputs || {}, safety: data.safety || {} });
      const order = ["SPOTTER", "PRIOR", "EDGE", "KELLY", "TAKER", "CLOSER"];
      order.forEach(role => {
        if (data.outputs && data.outputs[role]) appendMessage("assistant", role + " · " + (data.outputs[role].title || "研究角色") + "\n" + JSON.stringify(data.outputs[role], null, 2));
      });
      $("aiTeamStatus").textContent = "流程完成 · 研究模式";
      $("aiTeamStatus").className = "small-pill ai-status success";
      $("aiTeamOutput").textContent = "六角色流程完成；逐角色结构化结果已写入下方研究记录。TAKER 未自动创建订单。";
      appendMessage("assistant", "安全闸门：" + (data.safety && data.safety.note || "没有自动执行权限") + "\nToken 用量：" + JSON.stringify(data.usage || {}));
    } catch (error) {
      logResearchEvent("agent.run.failed", { runId, provider: config.provider, model: config.model, error: error.message || "网络请求失败", completedAt: new Date().toISOString() });
      $("aiTeamStatus").textContent = "连接失败";
      $("aiTeamStatus").className = "small-pill ai-status error";
      $("aiTeamOutput").textContent = "连接失败，未生成订单。";
      appendMessage("assistant", "六 Agent 请求未完成：" + (error.message || "未知错误"));
    } finally {
      busy = false;
      $("aiTeamRun").disabled = false;
      $("aiTest").disabled = false;
      $("aiRun").disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!$("aiProvider")) return;
    $("aiProvider").addEventListener("change", providerFields);
    if ($("paperSelfTestBtn")) $("paperSelfTestBtn").addEventListener("click", () => {
      try {
        const result = window.NRTradingRunPaperSelfTest();
        const price = value => Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 8 });
        const money = value => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });
        $("paperSelfTestStatus").textContent = "完成 · 独立账户";
        $("paperSelfTestStatus").className = "small-pill ai-status success";
        $("paperSelfTestResult").textContent = [
          "模拟往返完成 · " + result.symbol,
          "数量：" + price(result.qty),
          "买入均价：" + price(result.buyPrice) + " · 卖出均价：" + price(result.sellPrice),
          "买入手续费：" + money(result.buyFee) + " · 卖出手续费：" + money(result.sellFee),
          "往返净损益：" + money(result.realizedPnl),
          "模拟成交：" + result.trades + " 笔 · 撮合：" + result.liquidityModel,
          "独立临时账户；未写入主账户或浏览器存储。"
        ].join("\n");
      } catch (error) {
        $("paperSelfTestStatus").textContent = "未完成";
        $("paperSelfTestStatus").className = "small-pill ai-status error";
        $("paperSelfTestResult").textContent = error.message || "模拟自检失败";
      }
    });
    $("aiTest").addEventListener("click", () => run("test"));
    $("aiRun").addEventListener("click", () => run("analysis"));
    if ($("aiTeamRun")) $("aiTeamRun").addEventListener("click", runTeam);
    $("aiClearKey").addEventListener("click", () => {
      const provider = $("aiProvider").value;
      if (provider === "minimax") $("minimaxApiKey").value = "";
      else $("qwenApiKey").value = "";
      setStatus("当前密钥输入框已清空", "");
    });
    $("aiClearChat").addEventListener("click", () => {
      conversation.length = 0;
      $("aiOutput").textContent = "";
      setStatus("会话已清空", "");
    });
    providerFields();
  });
})();
