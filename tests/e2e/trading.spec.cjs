const { test, expect } = require("@playwright/test");
const paperLedgerByPage = new WeakMap();
const paperServerByPage = new WeakMap();

function newPaperAccount() {
  const now = new Date().toISOString();
  return { version: 1, generation: 1, initialCash: 10000, cash: 10000, reservedCash: 0, positions: {}, orders: [], trades: [], realizedPnl: 0, equityPeak: 10000, dayKey: now.slice(0, 10), dayStartEquity: 10000, lastBookSequence: {}, createdAt: now, updatedAt: now };
}

function addServerEvent(store, eventType, payload, commandId) {
  store.events.push({ seq: store.events.length + 1, eventId: (commandId || "test") + ":" + eventType + ":" + store.events.length, commandId: commandId || "test", eventType, schemaVersion: 1, payload, createdAt: new Date().toISOString() });
}

function marketDataRoute(route) {
  const url = new URL(route.request().url());
  const symbol = url.searchParams.get("symbol") || "BTCUSDT";
  const prices = { BTCUSDT: 100000, ETHUSDT: 3000, ORDIUSDT: 10, "1000SATSUSDT": 0.00001 };
  const price = prices[symbol] || 100;
  if (url.pathname.endsWith("/exchangeInfo")) {
    const steps = { BTCUSDT: "0.000001", ETHUSDT: "0.00001", ORDIUSDT: "0.01", "1000SATSUSDT": "1" };
    return route.fulfill({ json: { symbols: [{
      symbol, status: "TRADING",
      filters: [
        { filterType: "LOT_SIZE", minQty: steps[symbol] || "0.000001", maxQty: "100000000", stepSize: steps[symbol] || "0.000001" },
        { filterType: "PRICE_FILTER", minPrice: "0.00000001", maxPrice: "100000000", tickSize: symbol === "1000SATSUSDT" ? "0.00000001" : "0.01" },
        { filterType: "MIN_NOTIONAL", minNotional: "5" }
      ]
    }] } });
  }
  if (url.pathname.endsWith("/ticker/price")) {
    let symbols = [];
    try { symbols = JSON.parse(url.searchParams.get("symbols") || "[]"); } catch (_) {}
    return route.fulfill({ json: symbols.map(item => ({ symbol: item, price: String(prices[item] || 100) })) });
  }
  if (url.pathname.endsWith("/ticker/24hr")) {
    return route.fulfill({ json: { symbol, lastPrice: String(price), priceChangePercent: "1.25", quoteVolume: "12345678" } });
  }
  if (url.pathname.endsWith("/depth")) {
    return route.fulfill({ json: {
      lastUpdateId: 123,
      bids: [[String(price * 0.999), "2"], [String(price * 0.998), "5"]],
      asks: [[String(price), "2"], [String(price * 1.001), "5"]]
    } });
  }
  if (url.pathname.endsWith("/klines")) {
    const now = Date.now();
    const rows = Array.from({ length: 240 }, (_, index) => {
      const time = now - (240 - index) * 240 * 60 * 1000;
      return [time, String(price * 0.995), String(price * 1.01), String(price * 0.99), String(price), "10", time + 239 * 60 * 1000, "100000", 100, "5", "50000", "0"];
    });
    return route.fulfill({ json: rows });
  }
  return route.fulfill({ status: 404, json: { code: -1, msg: "not mocked" } });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("night-researcher.paper.v1"));
  await page.route("https://data-api.binance.vision/api/v3/**", marketDataRoute);
  await page.route("https://unpkg.com/**", route => route.abort());
  await page.route("https://cdn.jsdelivr.net/**", route => route.abort());
  const paperEvents = [];
  paperLedgerByPage.set(page, paperEvents);
  const paperServer = { account: newPaperAccount(), events: [], orderCalls: 0 };
  paperServerByPage.set(page, paperServer);
  await page.route("**/api/paper/account", async route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, mode: "server-authoritative-paper", account: paperServer.account,
      marks: { BTCUSDT: 100000, ETHUSDT: 3000, ORDIUSDT: 10, "1000SATSUSDT": 0.00001 },
      markQuality: "verified", version: paperServer.account.version, stateHash: "test-state-hash" })
  }));
  await page.route("**/api/paper/account/reset", async route => {
    const body = route.request().postDataJSON();
    paperServer.account = newPaperAccount();
    paperServer.account.version += 1;
    addServerEvent(paperServer, "paper.server.account.reset", { generation: paperServer.account.generation, confirmationId: body.confirmationId }, body.clientActionId);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, account: paperServer.account, marks: {}, version: paperServer.account.version }) });
  });
  await page.route("**/api/paper/orders", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ status: 405, json: { ok: false } });
    paperServer.orderCalls += 1;
    const input = route.request().postDataJSON();
    const account = paperServer.account;
    const price = input.symbol === "BTCUSDT" ? 100000 : input.symbol === "ETHUSDT" ? 3000 : input.symbol === "ORDIUSDT" ? 10 : 0.00001;
    const notional = Number(input.quantity) * (input.type === "LIMIT" ? Number(input.limitPrice) : price);
    const order = {
      id: "O-" + paperServer.orderCalls, clientOrderId: input.clientOrderId, confirmationId: input.confirmationId,
      symbol: input.symbol, side: input.side, type: input.type, qty: Number(input.quantity),
      limitPrice: input.limitPrice == null ? null : Number(input.limitPrice), status: "NEW",
      filledQty: 0, remainingQty: Number(input.quantity), avgFillPrice: null, fee: 0,
      realizedPnl: null, reservedCash: 0, reservedQty: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    if (notional > 1000) {
      order.status = "REJECTED"; order.remainingQty = 0; order.reason = "超过单笔风险上限（账户净值的 10%）";
      order.rejectionCode = "MAX_ORDER_PCT"; order.terminalAt = new Date().toISOString();
      account.orders.unshift(order); account.version += 1;
      addServerEvent(paperServer, "paper.server.order.rejected", { order, reason: order.reason }, input.clientOrderId);
      addServerEvent(paperServer, "paper.server.account.snapshot", { version: account.version, account }, input.clientOrderId);
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: true, accepted: false, account, order, rejection: { reason: order.reason } }) });
    }
    if (input.side === "SELL" && !(account.positions[input.symbol] && account.positions[input.symbol].qty >= input.quantity)) {
      order.status = "REJECTED"; order.remainingQty = 0; order.reason = "现货模拟账户没有足够可卖持仓";
      order.rejectionCode = "INSUFFICIENT_POSITION"; order.terminalAt = new Date().toISOString();
      account.orders.unshift(order); account.version += 1;
      addServerEvent(paperServer, "paper.server.order.rejected", { order, reason: order.reason }, input.clientOrderId);
      addServerEvent(paperServer, "paper.server.account.snapshot", { version: account.version, account }, input.clientOrderId);
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: true, accepted: false, account, order, rejection: { reason: order.reason } }) });
    }
    const fee = notional * 0.001;
    const fill = {
      id: "F-" + order.id + "-001", fillIndex: 1, orderId: order.id, timestamp: new Date().toISOString(),
      symbol: input.symbol, side: input.side, qty: Number(input.quantity), price, notional, fee,
      realizedPnl: null, liquidityModel: "server-visible-orderbook-walk", bookSequence: 123, bookReceivedAt: new Date().toISOString()
    };
    if (input.side === "BUY") {
      const position = account.positions[input.symbol] || { qty: 0, avgPrice: 0, reservedQty: 0 };
      position.avgPrice = ((position.qty * position.avgPrice) + notional + fee) / (position.qty + fill.qty);
      position.qty += fill.qty; account.positions[input.symbol] = position; account.cash -= notional + fee;
    } else {
      const position = account.positions[input.symbol];
      fill.realizedPnl = notional - fee - position.avgPrice * fill.qty;
      position.qty -= fill.qty; account.cash += notional - fee; account.realizedPnl += fill.realizedPnl;
      if (position.qty <= 1e-10) delete account.positions[input.symbol];
    }
    order.status = "FILLED"; order.filledQty = fill.qty; order.remainingQty = 0; order.avgFillPrice = price;
    order.fee = fee; order.realizedPnl = fill.realizedPnl; order.terminalAt = new Date().toISOString();
    account.orders.unshift(order); account.trades.unshift(fill); account.version += 1; account.updatedAt = new Date().toISOString();
    addServerEvent(paperServer, "paper.server.order.created", { order, request: input, book: { sequence: 123, receivedAt: fill.bookReceivedAt } }, input.clientOrderId);
    addServerEvent(paperServer, "paper.server.order.filled", { orderId: order.id, fill, fillIndex: 1, bookSequence: 123 }, input.clientOrderId);
    addServerEvent(paperServer, "paper.server.account.snapshot", { version: account.version, account, stateHash: "test-state-hash" }, input.clientOrderId);
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, accepted: true, account, order, fills: [fill], marks: { [input.symbol]: price } }) });
  });
  await page.route("**/api/paper/market/tick", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, changed: false, reason: "NO_OPEN_ORDERS" }) }));
  await page.route("**/api/paper/orders/*/cancel", async route => {
    const id = new URL(route.request().url()).pathname.split("/").slice(-2)[0];
    const order = paperServer.account.orders.find(item => item.id === id);
    if (order) { order.status = "CANCELED"; order.remainingQty = 0; paperServer.account.version += 1; }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "CANCELED", account: paperServer.account, order }) });
  });
  await page.route("**/api/paper/events**", async route => {
    const url = new URL(route.request().url());
    const after = Number(url.searchParams.get("after") || 0);
    const limit = Number(url.searchParams.get("limit") || 100);
    const events = paperServer.events.filter(item => item.seq > after).slice(0, limit);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, events, nextAfter: events.length ? events[events.length - 1].seq : after }) });
  });
  await page.route("**/api/paper/replay", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, verified: true, snapshots: paperServer.events.filter(e => e.eventType === "paper.server.account.snapshot").length, account: paperServer.account, replayedVersion: paperServer.account.version }) }));
  await page.route("**/api/paper/session", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, session: "created", expiresIn: 604800 })
  }));
  await page.route("**/api/paper/ledger**", async route => {
    const request = route.request();
    if (request.method() === "POST") {
      const event = request.postDataJSON();
      if (!paperEvents.some(item => item.eventId === event.eventId)) {
        paperEvents.push({ seq: paperEvents.length + 1, ...event, createdAt: new Date().toISOString() });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, accepted: [{ eventId: event.eventId }] }) });
    }
    const url = new URL(request.url());
    const limit = Number(url.searchParams.get("limit") || 50);
    let rows = paperEvents.slice();
    if (url.searchParams.get("eventType")) rows = rows.filter(item => item.eventType === url.searchParams.get("eventType"));
    if (url.searchParams.get("latest") === "1") rows = rows.slice(-limit);
    else rows = rows.filter(item => item.seq > Number(url.searchParams.get("after") || 0)).slice(0, limit);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, events: rows, nextAfter: rows.length ? rows[rows.length - 1].seq : 0 }) });
  });
  await page.route("**/api/ai/chat", async route => {
    const payload = route.request().postDataJSON();
    const valid = !!payload.apiKey && Array.isArray(payload.messages);
    await route.fulfill({
      status: valid ? 200 : 400,
      contentType: "application/json",
      body: JSON.stringify(valid
        ? { ok: true, provider: payload.provider, model: payload.model, text: "AI_READY", usage: { total_tokens: 11 } }
        : { error: "missing API key" })
    });
  });
  await page.route("**/api/agents/research", async route => {
    const payload = route.request().postDataJSON();
    const valid = !!payload.apiKey && !!payload.snapshot;
    const startedAt = new Date().toISOString();
    const completedAt = new Date().toISOString();
    const outputs = {
      SPOTTER: { title: "机会发现", opportunities: [] },
      PRIOR: { title: "市场先验", regime: "unknown", evidence: [] },
      EDGE: { title: "优势验证", verdict: "WATCH", invalidation: "OOS 失效" },
      KELLY: { status: "BLOCKED", allocationPct: 0 },
      TAKER: { status: "BLOCKED", autoSubmit: false },
      CLOSER: { title: "退出与复盘", decision: "HOLD_RESEARCH", exit_conditions: [] }
    };
    if (valid) {
      paperEvents.push({
        seq: paperEvents.length + 1,
        eventId: "agent.run.started:" + payload.runId,
        eventType: "agent.run.started",
        payload: { runId: payload.runId, provider: payload.provider, model: payload.model, promptVersion: "nr-agent-research-v1" },
        createdAt: startedAt
      });
      paperEvents.push({
        seq: paperEvents.length + 1,
        eventId: "risk.decision:" + payload.runId,
        eventType: "risk.decision",
        payload: { runId: payload.runId, decision: "BLOCKED", kellyStatus: "BLOCKED", allocationPct: 0, autoSubmit: false },
        createdAt: completedAt
      });
      paperEvents.push({
        seq: paperEvents.length + 1,
        eventId: "agent.run.completed:" + payload.runId,
        eventType: "agent.run.completed",
        payload: { runId: payload.runId, snapshotHash: "a".repeat(64), outputs, usage: { total_tokens: 60 } },
        createdAt: completedAt
      });
    }
    await route.fulfill({
      status: valid ? 200 : 400,
      contentType: "application/json",
      body: JSON.stringify(valid ? {
        ok: true,
        runId: payload.runId,
        snapshotHash: "a".repeat(64),
        provider: payload.provider,
        requestedModel: payload.model,
        promptVersion: "nr-agent-research-v1",
        startedAt,
        completedAt,
        durationMs: 1,
        roles: ["SPOTTER", "PRIOR", "EDGE", "KELLY", "TAKER", "CLOSER"],
        outputs,
        usage: { total_tokens: 60 },
        safety: { autoExecution: false, note: "无自动下单权限" }
      } : { error: "missing API key or snapshot" })
    });
  });
  await page.goto("/trading.html");
});

test("loads public market data and executes a server-authoritative paper market buy", async ({ page }) => {
  await expect(page.locator("#ticker-BTCUSDT")).toContainText("100,000");
  await expect(page.locator("#midPrice")).toContainText("99,950");
  await expect(page.locator("#paperLedgerStatus")).toContainText("服务端权威账本已连接");
  await expect(page.locator("#submitOrder")).toBeEnabled();
  await page.locator("#orderQty").fill("0.005");
  await page.locator("#submitOrder").click();
  await expect(page.locator("#orderFeedback")).toContainText("已全部成交");
  await expect(page.locator("#tradeCount")).toHaveText("1 笔");
  const store = paperServerByPage.get(page);
  expect(store.orderCalls).toBe(1);
  expect(store.account.trades).toHaveLength(1);
  expect(store.account.trades[0].liquidityModel).toBe("server-visible-orderbook-walk");
  expect(store.account.cash).toBeLessThan(10000);
  expect(await page.evaluate(() => localStorage.getItem("night-researcher.paper.v1"))).toBeNull();
  const beforeSelfTest = { cash: store.account.cash, trades: store.account.trades.length };
  await page.locator("#paperSelfTestBtn").click();
  await expect(page.locator("#paperSelfTestStatus")).toContainText("完成");
  await expect(page.locator("#paperSelfTestResult")).toContainText("模拟往返完成");
  expect(store.account.cash).toBe(beforeSelfTest.cash);
  expect(store.account.trades).toHaveLength(beforeSelfTest.trades);
});

test("server paper account restores after reload without trusting browser localStorage", async ({ page }) => {
  await page.locator("#orderQty").fill("0.005");
  await page.locator("#submitOrder").click();
  await expect(page.locator("#orderFeedback")).toContainText("已全部成交");
  expect(paperServerByPage.get(page).account.trades).toHaveLength(1);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator("#tradeCount")).toHaveText("1 笔");
  await expect(page.locator("#paperLedgerStatus")).toContainText("服务端权威账本已连接");
  expect(paperServerByPage.get(page).account.trades).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem("night-researcher.paper.v1"))).toBeNull();
});

test("audit timeline renders server paper events and verifies full state replay", async ({ page }) => {
  await page.locator("#orderQty").fill("0.005");
  await page.locator("#submitOrder").click();
  await expect(page.locator("#orderFeedback")).toContainText("已全部成交");
  await expect(page.locator("#auditEvents")).toContainText("服务端权威账户快照");
  await expect(page.locator("#auditEvents")).toContainText("服务端模拟成交");
  await page.locator("#refreshAuditBtn").click();
  await expect(page.locator("#auditEvents")).toContainText("服务端模拟成交");
  await page.locator("#replayPaperBtn").click();
  await expect(page.locator("#paperLedgerStatus")).toContainText("回放校验通过");
});

test("server enforces the per-order risk cap before paper execution", async ({ page }) => {
  await expect(page.locator("#submitOrder")).toBeEnabled();
  await page.locator("#orderQty").fill("0.02");
  await page.locator("#submitOrder").click();
  await expect(page.locator("#orderFeedback")).toContainText("单笔风险上限");
  expect(paperServerByPage.get(page).orderCalls).toBe(1);
  expect(paperServerByPage.get(page).account.trades).toHaveLength(0);
  await expect(page.locator("#equityValue")).toContainText("10,000");
});

test("MiniMax and Qwen key forms call the same-origin AI endpoint without persisting keys", async ({ page }) => {
  await page.locator("#minimaxApiKey").fill("mm-browser-test-key-123456");
  await page.locator("#aiTest").click();
  await expect(page.locator("#aiStatus")).toContainText("连接成功");
  await expect(page.locator("#aiOutput")).toContainText("AI_READY");

  await page.locator("#aiProvider").selectOption("qwen");
  await expect(page.locator("#qwenFields")).toBeVisible();
  await page.locator("#qwenApiKey").fill("sk-browser-test-key-123456");
  await page.locator("#qwenWorkspaceId").fill("ws-test");
  await page.locator("#aiTest").click();
  await expect(page.locator("#aiStatus")).toContainText("连接成功");

  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain("mm-browser-test-key-123456");
  expect(stored).not.toContain("sk-browser-test-key-123456");
});

test("AI Provider Center is visible and the six-agent flow never persists keys", async ({ page }) => {
  await expect(page.locator("#aiProviderCenter")).toBeVisible();
  await expect(page.locator("#aiProvider")).toBeVisible();
  await expect(page.locator("#minimaxApiKey")).toBeVisible();
  await page.locator("#minimaxApiKey").fill("mm-team-browser-test-key-123456");
  await page.locator("#aiTeamRun").click();
  await expect(page.locator("#aiTeamStatus")).toContainText("流程完成");
  await expect(page.locator("#aiOutput")).toContainText("SPOTTER");
  await expect(page.locator("#aiOutput")).toContainText("KELLY");
  await expect(page.locator("#auditEvents")).toContainText("六角色研究 · 已完成");
  await expect(page.locator("#auditEvents")).toContainText("风险决策 · BLOCKED");
  const events = paperLedgerByPage.get(page);
  await expect.poll(() => events.some(event => event.eventType === "agent.run.started")).toBeTruthy();
  await expect.poll(() => events.some(event => event.eventType === "agent.run.completed")).toBeTruthy();
  const started = events.find(event => event.eventType === "agent.run.started");
  const completed = events.find(event => event.eventType === "agent.run.completed");
  expect(completed.payload.runId).toBe(started.payload.runId);
  expect(completed.payload.outputs.KELLY.status).toBe("BLOCKED");
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain("mm-team-browser-test-key-123456");
});

test("dedicated AI settings page is directly discoverable from trading header", async ({ page }) => {
  await expect(page.locator('a.ai-nav-link')).toHaveAttribute("href", "ai-settings.html");
  await page.locator('a.ai-nav-link').click();
  await expect(page).toHaveURL(/ai-settings\.html$/);
  await expect(page.getByRole("heading", { name: "AI 模型与 API 设置" })).toBeVisible();
  await expect(page.locator("#minimaxApiKey")).toBeVisible();
  await page.locator("#aiProvider").selectOption("qwen");
  await expect(page.locator("#qwenFields")).toBeVisible();
  await expect(page.locator("#qwenApiKey")).toBeVisible();
  await expect(page.locator("#qwenWorkspaceId")).toBeVisible();
  await page.locator("#qwenApiKey").fill("sk-settings-browser-test-key-123456");
  await page.locator("#qwenWorkspaceId").fill("ws-settings-test");
  await page.locator("#aiTest").click();
  await expect(page.locator("#aiStatus")).toContainText("连接成功");
  const stored = await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
  expect(stored).not.toContain("sk-settings-browser-test-key-123456");
});

test("loads the deterministic depth sequence engine before the live trading client", async ({ page }) => {
  const loaded = await page.evaluate(() => ({
    create: typeof window.NRDepthBook?.create,
    applyDiff: typeof window.NRDepthBook?.applyDiff,
    trading: typeof window.NRTradingSelectSymbol
  }));
  expect(loaded).toEqual({ create: "function", applyDiff: "function", trading: "function" });
});
