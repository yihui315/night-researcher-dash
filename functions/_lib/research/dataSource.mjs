// Pluggable market-data source interface + a deterministic OFFLINE mock.
//
// The interface is intentionally tiny so a real exchange/binance source can be swapped in
// later without touching the pipeline:
//   interface MarketDataSource {
//     listSymbols(): string[]
//     getSnapshot(symbol, opts?): Promise<MarketSnapshot>   // single point-in-time snapshot
//     getSeries(symbol, { fromIso, toIso, stepMs }): Promise<MarketSnapshot[]>
//   }
//
// MarketSnapshot = {
//   symbol, timestamp (ISO-8601), lastPrice, bid, ask, spread, volume24h,
//   high24h, low24h, orderBook: { bids: [[price, qty]...], asks: [[price, qty]...] }
// }

export const DEFAULT_SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT", "ORDIUSDT"]);

// Deterministic PRNG (mulberry32) so mock runs are reproducible offline.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Per-symbol base prices so the three assets look distinct but stable.
const BASE_PRICE = Object.freeze({ BTCUSDT: 68000, ETHUSDT: 3500, ORDIUSDT: 28 });

export class MockMarketDataSource {
  constructor({ symbols = DEFAULT_SYMBOLS, seed = 20261103, volatility = 0.012 } = {}) {
    this.symbols = symbols;
    this.seed = seed;
    this.volatility = volatility;
  }

  listSymbols() {
    return [...this.symbols];
  }

  // Generate one deterministic snapshot for `symbol` at `opts.timestamp` (Date or ms).
  // The same (symbol, timestamp) always yields the same snapshot (seeded by symbol+timestamp).
  async getSnapshot(symbol, opts = {}) {
    if (!this.symbols.includes(symbol)) {
      throw new Error("MockMarketDataSource 不支持的交易对: " + symbol);
    }
    const ts = opts.timestamp instanceof Date ? opts.timestamp.getTime() : Number(opts.timestamp || Date.now());
    const rand = mulberry32(hashSeed(symbol + ":" + Math.floor(ts / 60000))); // 1-min resolution seeding
    const base = BASE_PRICE[symbol] || 100;
    // Geometric-random-walk-ish wiggle around base, deterministic per minute bucket.
    const drift = (rand() - 0.5) * 2 * this.volatility;
    const lastPrice = round(base * (1 + drift), symbol === "ORDIUSDT" ? 4 : 2);
    const spreadBps = 1 + rand() * 3; // 1..4 bps
    const half = lastPrice * (spreadBps / 10000) / 2;
    const bid = round(lastPrice - half, symbol === "ORDIUSDT" ? 4 : 2);
    const ask = round(lastPrice + half, symbol === "ORDIUSDT" ? 4 : 2);
    const volume24h = round(1000 + rand() * 9000, 2);
    const high24h = round(lastPrice * (1 + this.volatility), symbol === "ORDIUSDT" ? 4 : 2);
    const low24h = round(lastPrice * (1 - this.volatility), symbol === "ORDIUSDT" ? 4 : 2);

    const bids = [];
    const asks = [];
    for (let i = 0; i < 5; i++) {
      bids.push([round(bid - i * half, symbol === "ORDIUSDT" ? 4 : 2), round(0.5 + rand() * 5, 4)]);
      asks.push([round(ask + i * half, symbol === "ORDIUSDT" ? 4 : 2), round(0.5 + rand() * 5, 4)]);
    }

    return {
      symbol,
      timestamp: new Date(ts).toISOString(),
      timestampMs: ts,
      lastPrice,
      bid,
      ask,
      spread: round(ask - bid, symbol === "ORDIUSDT" ? 4 : 2),
      volume24h,
      high24h,
      low24h,
      orderBook: { bids, asks }
    };
  }

  // Generate a series of snapshots from `fromIso` to `toIso` every `stepMs`.
  async getSeries(symbol, { fromIso, toIso, stepMs = 60 * 60 * 1000 } = {}) {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      throw new Error("getSeries 需要有效的 fromIso/toIso");
    }
    const out = [];
    for (let t = from; t <= to; t += stepMs) {
      out.push(await this.getSnapshot(symbol, { timestamp: t }));
    }
    return out;
  }
}

function round(value, decimals) {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}
