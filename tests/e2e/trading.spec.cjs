const { test, expect } = require("@playwright/test");

function marketDataRoute(route) {
  const url = new URL(route.request().url());
  const symbol = url.searchParams.get("symbol") || "BTCUSDT";
  const prices = { BTCUSDT: 100000, ETHUSDT: 3000, ORDIUSDT: 10, "1000SATSUSDT": 0.00001 };
  const price = prices[symbol] || 100;
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
  await page.goto("/trading.html");
});

test("loads public market data and executes a depth-based paper market buy", async ({ page }) => {
  await expect(page.locator("#ticker-BTCUSDT")).toContainText("100,000");
  await expect(page.locator("#midPrice")).toContainText("99,950");
  await expect(page.locator("#submitOrder")).toBeEnabled();

  await page.locator("#orderQty").fill("0.005");
  await page.locator("#submitOrder").click();
  await expect(page.locator("#orderFeedback")).toContainText("模拟成交成功");
  await expect(page.locator("#tradeCount")).toHaveText("1 笔");

  const account = await page.evaluate(() => JSON.parse(localStorage.getItem("night-researcher.paper.v1")));
  expect(account.trades).toHaveLength(1);
  expect(account.trades[0].liquidityModel).toBe("visible-orderbook-walk");
  expect(account.cash).toBeLessThan(10000);
});

test("enforces the per-order risk cap before paper execution", async ({ page }) => {
  await expect(page.locator("#submitOrder")).toBeEnabled();
  await page.locator("#orderQty").fill("0.02");
  await page.locator("#submitOrder").click();
  await expect(page.locator("#orderFeedback")).toContainText("单笔风险上限");
  const stored = await page.evaluate(() => localStorage.getItem("night-researcher.paper.v1"));
  if (stored) expect(JSON.parse(stored).trades).toHaveLength(0);
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
