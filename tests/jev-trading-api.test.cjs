const test = require("node:test");
const assert = require("node:assert/strict");
const { createTradingApi, TradingApiError } = require("../integration/jev/tradingApi.mjs");

test("JEV adapter can probe the existing provider health API independently of trading routes", async () => {
  const calls = [];
  const api = createTradingApi({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: "ok", provider_mode: "REAL" }), { status: 200 });
    }
  });
  const health = await api.getProviderHealth();
  assert.equal(health.status, "ok");
  assert.equal(calls[0].url, "/api/health");
  assert.equal(calls[0].init.credentials, "same-origin");
});

test("JEV adapter uses same-origin routes and never sends provider credentials", async () => {
  const calls = [];
  const api = createTradingApi({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ runId: "run-123", status: "queued", autoExecution: false }), {
        status: 202, headers: { "content-type": "application/json" }
      });
    }
  });
  const result = await api.createResearchRun({
    providerId: "minimax",
    modelOverride: "MiniMax-M3",
    symbols: ["BTCUSDT", "ORDIUSDT"],
    snapshotId: "snapshot-1",
    strategyVersion: "ema-v2",
    apiKey: "must-not-be-forwarded"
  });
  assert.equal(result.runId, "run-123");
  assert.equal(calls[0].url, "/api/v1/trading/research/runs");
  assert.equal(calls[0].init.credentials, "same-origin");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.symbols, ["BTCUSDT", "ORDIUSDT"]);
  assert.equal(body.providerId, "minimax");
  assert.equal("apiKey" in body, false);
  assert.equal("apiKey" in calls[0].init.headers, false);
});

test("JEV adapter serializes market queries and validates required symbols", async () => {
  const calls = [];
  const api = createTradingApi({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  await api.getMarketSnapshot({ symbols: ["BTCUSDT", "ETHUSDT"], interval: "4h" });
  await api.getOrderBook({ venue: "binance-spot", symbol: "BTCUSDT" });
  assert.match(calls[0].url, /symbols=BTCUSDT%2CETHUSDT/);
  assert.match(calls[0].url, /interval=4h/);
  assert.match(calls[1].url, /venue=binance-spot/);
  assert.match(calls[1].url, /symbol=BTCUSDT/);
  assert.throws(() => api.getOrderBook({ venue: "binance-spot" }), /symbol is required/);
});

test("JEV paper order adapter requires explicit human confirmation and valid quantity", async () => {
  const calls = [];
  const api = createTradingApi({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ orderId: "paper-1", status: "FILLED" }), { status: 201 });
    }
  });
  assert.throws(() => api.createPaperOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.001 }), /confirmationId/);
  assert.throws(() => api.createPaperOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0, confirmationId: "confirm-1" }), /quantity/);
  const result = await api.createPaperOrder({
    symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.001,
    confirmationId: "confirm-1", researchRunId: "run-123"
  });
  assert.equal(result.orderId, "paper-1");
  assert.equal(calls[0].url, "/api/v1/trading/paper/orders");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.confirmationId, "confirm-1");
  assert.equal(body.researchRunId, "run-123");
});

test("JEV adapter normalizes API errors without exposing request credentials", async () => {
  const api = createTradingApi({
    fetchImpl: async () => new Response(JSON.stringify({ error: "risk gate rejected", code: "RISK_REJECTED" }), {
      status: 409, headers: { "content-type": "application/json" }
    })
  });
  await assert.rejects(() => api.getPaperAccount(), error => {
    assert.ok(error instanceof TradingApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "RISK_REJECTED");
    assert.match(error.message, /risk gate rejected/);
    return true;
  });
});


test("JEV adapter reads ProviderRegistry and can probe a configured provider without credentials", async () => {
  const calls = [];
  const api = createTradingApi({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/v1/providers") {
        return new Response(JSON.stringify({ providers: [
          { id: "typesafe_jev", display_state: "CONNECTED", model: "jev-latest" },
          { id: "minimax", display_state: "CONNECTED", model: "MiniMax-M3" },
          { id: "qwen_coding_plan_cn", display_state: "AUTH_MISSING" }
        ] }), { status: 200 });
      }
      if (url.endsWith("/minimax/probe")) {
        return new Response(JSON.stringify({ ok: true, state: "READY", model: "MiniMax-M3" }), { status: 200 });
      }
      if (url.endsWith("/minimax/models")) {
        return new Response(JSON.stringify({ models: ["MiniMax-M3"] }), { status: 200 });
      }
      throw new Error("Unexpected JEV route " + url);
    }
  });
  const providers = await api.listProviders();
  assert.equal(providers.providers[1].id, "minimax");
  const probe = await api.probeProvider("minimax");
  assert.equal(probe.state, "READY");
  const models = await api.listProviderModels("minimax");
  assert.deepEqual(models.models, ["MiniMax-M3"]);
  assert.equal(calls[1].url, "/api/v1/providers/minimax/probe");
  assert.equal(calls[1].init.method, "POST");
  assert.equal("apiKey" in calls[1].init.headers, false);
  assert.equal("apiKey" in JSON.parse(calls[1].init.body), false);
  assert.throws(() => api.probeProvider(""), /providerId is required/);
});
