/* Night Researcher AI Copilot — keys and conversation remain in page memory only. */
"use strict";
(function () {
  const $ = id => document.getElementById(id);
  const conversation = [];
  let busy = false;

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

  document.addEventListener("DOMContentLoaded", () => {
    if (!$("aiProvider")) return;
    $("aiProvider").addEventListener("change", providerFields);
    $("paperSelfTestBtn").addEventListener("click", () => {
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
