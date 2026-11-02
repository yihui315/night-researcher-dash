/**
 * JEV Trading Desk API adapter.
 * Copy this module into JEV frontend src/features/trading/services/.
 * It intentionally sends provider IDs only; credentials stay in JEV ProviderRegistry/DPAPI.
 */
const DEFAULT_BASE = "/api/v1/trading";

function makeRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "nr-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

export class TradingApiError extends Error {
  constructor(message, status, code, requestId) {
    super(message);
    this.name = "TradingApiError";
    this.status = status;
    this.code = code || null;
    this.requestId = requestId || null;
  }
}

export function createTradingApi(options = {}) {
  const fetchImpl = options.fetchImpl || fetch.bind(globalThis);
  const baseUrl = String(options.baseUrl || DEFAULT_BASE).replace(/\/$/, "");

  async function requestAt(url, init = {}) {
    const requestId = makeRequestId();
    const response = await fetchImpl(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: {
        accept: "application/json",
        "x-request-id": requestId,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {})
      }
    });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) {
      throw new TradingApiError(
        body.error || body.message || ("Trading API failed with HTTP " + response.status),
        response.status,
        body.code,
        body.requestId || requestId
      );
    }
    return body;
  }

  const request = (path, init) => requestAt(baseUrl + path, init);
  const requestRoot = (path, init) => requestAt(path, init);

  return {
    getProviderHealth: () => requestRoot("/api/health"),
    listProviders: () => requestRoot("/api/v1/providers"),
    probeProvider: providerId => {
      if (!providerId) throw new TypeError("providerId is required");
      return requestRoot("/api/v1/providers/" + encodeURIComponent(providerId) + "/probe", { method: "POST", body: "{}" });
    },
    listProviderModels: providerId => {
      if (!providerId) throw new TypeError("providerId is required");
      return requestRoot("/api/v1/providers/" + encodeURIComponent(providerId) + "/models");
    },
    getHealth: () => request("/health"),
    getMarketSnapshot: (params = {}) => {
      const query = new URLSearchParams();
      if (params.symbols && params.symbols.length) query.set("symbols", params.symbols.join(","));
      if (params.interval) query.set("interval", params.interval);
      return request("/market/snapshot" + (query.size ? "?" + query.toString() : ""));
    },
    getOrderBook: ({ venue = "binance-spot", symbol }) => {
      if (!symbol) throw new TypeError("symbol is required");
      const query = new URLSearchParams({ venue, symbol });
      return request("/market/orderbook?" + query.toString());
    },
    createResearchRun: input => {
      if (!input || !input.providerId || !Array.isArray(input.symbols) || !input.symbols.length) {
        throw new TypeError("providerId and at least one symbol are required");
      }
      return request("/research/runs", {
        method: "POST",
        body: JSON.stringify({
          providerId: input.providerId,
          modelOverride: input.modelOverride || undefined,
          symbols: input.symbols,
          snapshotId: input.snapshotId || undefined,
          strategyVersion: input.strategyVersion || undefined
        })
      });
    },
    getResearchRun: runId => {
      if (!runId) throw new TypeError("runId is required");
      return request("/research/runs/" + encodeURIComponent(runId));
    },
    listStrategies: () => request("/strategies"),
    getPaperAccount: () => request("/paper/account"),
    createPaperOrder: input => {
      if (!input || !input.confirmationId) throw new TypeError("human confirmationId is required");
      if (!input.symbol || !["BUY", "SELL"].includes(input.side) || !["MARKET", "LIMIT"].includes(input.type)) {
        throw new TypeError("symbol, side and order type are required");
      }
      if (!(Number(input.quantity) > 0)) throw new TypeError("quantity must be greater than zero");
      return request("/paper/orders", {
        method: "POST",
        body: JSON.stringify({
          symbol: input.symbol,
          side: input.side,
          type: input.type,
          quantity: Number(input.quantity),
          ...(input.limitPrice != null ? { limitPrice: Number(input.limitPrice) } : {}),
          confirmationId: input.confirmationId,
          researchRunId: input.researchRunId || undefined
        })
      });
    },
    cancelPaperOrder: orderId => {
      if (!orderId) throw new TypeError("orderId is required");
      return request("/paper/orders/" + encodeURIComponent(orderId) + "/cancel", { method: "POST", body: "{}" });
    },
    subscribeEvents: options => {
      if (typeof EventSource === "undefined") throw new Error("EventSource is not supported in this browser");
      const url = baseUrl + "/events" + (options && options.after ? "?after=" + encodeURIComponent(options.after) : "");
      return new EventSource(url, { withCredentials: true });
    }
  };
}
