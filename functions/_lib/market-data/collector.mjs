// functions/_lib/market-data/collector.mjs — 真实行情采集（T05 / P1-1）
//
// 设计目标（来自 V3.0 管理决定）：
//   - 首批：BTCUSDT、ETHUSDT、ORDIUSDT。
//   - 第一数据源：Binance 公共市场数据（无需 API Key、无真实资金）。
//   - 第二数据源：OKX 公共数据，用于交叉验证。
//   - 每条行情至少保存：交易所+交易对、事件时间与接收时间、K线周期、OHLCV、
//     成交记录、盘口快照、原始数据校验值、数据缺失标记。
//
// 关键约束：本模块绝不持有交易 API Key，绝不下单。采集动作可注入 fetchImpl，
// 以便离线验收（Mock Replay）与在 Cloudflare Worker / Node 双环境运行。

import { createHash } from "node:crypto";

export const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "ORDIUSDT"];
export const PRIMARY_EXCHANGE = "binance";
export const SECONDARY_EXCHANGE = "okx";

function sha256(str) {
  return createHash("sha256").update(str).digest("hex");
}

// ---- Binance 公共端点（无需 Key） ----

export async function fetchBinanceKlines(symbol, interval, limit, fetchImpl = fetch) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(
    symbol,
  )}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`binance klines ${res.status}`);
  const rows = await res.json();
  return rows;
}

export async function fetchBinanceTrades(symbol, limit, fetchImpl = fetch) {
  const url = `https://api.binance.com/api/v3/trades?symbol=${encodeURIComponent(
    symbol,
  )}&limit=${limit}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`binance trades ${res.status}`);
  return res.json();
}

export async function fetchBinanceDepth(symbol, limit, fetchImpl = fetch) {
  const url = `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(
    symbol,
  )}&limit=${limit}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`binance depth ${res.status}`);
  return res.json();
}

// ---- OKX 公共端点（交叉验证，无需 Key） ----

export async function fetchOkxCandles(symbol, interval, limit, fetchImpl = fetch) {
  // OKX 交易对分隔符为 "-"，bar 周期映射
  const instId = symbol.replace(/USDT$/, "-USDT");
  const bar = interval; // OKX 也支持 1m/5m 等
  const url = `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(
    instId,
  )}&bar=${bar}&limit=${limit}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`okx candles ${res.status}`);
  const j = await res.json();
  if (j.code !== "0") throw new Error(`okx candles code ${j.code}`);
  return j.data; // [[ts_ms, o, h, l, c, vol, ...], ...]
}

// ---- 归一化 ----

export function normalizeBinanceKline(row) {
  // row: [openTime, open, high, low, close, volume, closeTime, ...]
  return {
    openTime: Number(row[0]),
    open: String(row[1]),
    high: String(row[2]),
    low: String(row[3]),
    close: String(row[4]),
    volume: String(row[5]),
    closeTime: Number(row[6]),
  };
}

export function normalizeOkxCandle(item) {
  // item: [ts_ms(str), o, h, l, c, vol, ...]
  return {
    ts: Number(item[0]),
    open: String(item[1]),
    high: String(item[2]),
    low: String(item[3]),
    close: String(item[4]),
    volume: String(item[5]),
  };
}

// 交叉验证：比较 Binance 最新收盘与 OKX 最新收盘（允许一定价差阈值）
export function crossValidate(binanceClose, okxClose, maxSpreadRatio = 0.005) {
  const b = parseFloat(binanceClose);
  const o = parseFloat(okxClose);
  if (!Number.isFinite(b) || !Number.isFinite(o)) {
    return { matched: false, reason: "价格解析失败", binanceClose: binanceClose, okxClose: okxClose };
  }
  const spread = Math.abs(b - o) / Math.max(b, o);
  return {
    matched: spread <= maxSpreadRatio,
    spreadRatio: spread,
    binanceClose: b,
    okxClose: o,
  };
}

// ---- 单标的采集 ----

export async function collectSymbol(symbol, opts = {}) {
  const {
    interval = "1m",
    limit = 1,
    depthLimit = 5,
    tradeLimit = 10,
    fetchImpl = fetch,
    crossValidate: doCross = true,
    maxSpreadRatio = 0.005,
  } = opts;

  const record = {
    exchange: PRIMARY_EXCHANGE,
    symbol,
    interval,
    eventTime: null,
    recvTime: null,
    ohlcv: null,
    lastTrades: null,
    orderbook: null,
    rawChecksum: null,
    crossValidation: null,
    missingFlag: {},
  };

  const recvTime = Date.now();
  const missing = record.missingFlag;
  try {
    const klines = await fetchBinanceKlines(symbol, interval, limit, fetchImpl);
    if (!Array.isArray(klines) || !klines.length) {
      missing.klines = "empty";
    } else {
      const k = normalizeBinanceKline(klines[klines.length - 1]);
      record.ohlcv = k;
      record.eventTime = k.closeTime || k.openTime;
    }
  } catch (e) {
    missing.klines = e.message;
  }

  try {
    record.lastTrades = await fetchBinanceTrades(symbol, tradeLimit, fetchImpl);
  } catch (e) {
    missing.trades = e.message;
  }

  try {
    const depth = await fetchBinanceDepth(symbol, depthLimit, fetchImpl);
    record.orderbook = { lastUpdateId: depth.lastUpdateId ?? null, bids: depth.bids ?? [], asks: depth.asks ?? [] };
  } catch (e) {
    missing.depth = e.message;
  }

  record.recvTime = recvTime;

  // 原始数据校验值（覆盖可获得的原始 payload）
  try {
    const rawPayload = JSON.stringify({
      ohlcv: record.ohlcv,
      trades: record.lastTrades,
      orderbook: record.orderbook,
    });
    record.rawChecksum = sha256(rawPayload);
  } catch {
    missing.checksum = "计算失败";
  }

  // 第二数据源交叉验证
  if (doCross && record.ohlcv) {
    try {
      const okx = await fetchOkxCandles(symbol, interval, limit, fetchImpl);
      if (Array.isArray(okx) && okx.length) {
        const o = normalizeOkxCandle(okx[0]);
        record.crossValidation = crossValidate(record.ohlcv.close, o.close, maxSpreadRatio);
      } else {
        missing.secondSource = "empty";
      }
    } catch (e) {
      missing.secondSource = e.message;
    }
  }

  return record;
}

export function isComplete(record) {
  return !record.missingFlag || Object.keys(record.missingFlag).length === 0;
}

export async function collectSnapshot(symbols = DEFAULT_SYMBOLS, opts = {}) {
  const records = [];
  for (const symbol of symbols) {
    records.push(await collectSymbol(symbol, opts));
  }
  return {
    collectedAt: new Date().toISOString(),
    primary: PRIMARY_EXCHANGE,
    secondary: SECONDARY_EXCHANGE,
    symbols: symbols.slice(),
    records,
    complete: records.every(isComplete),
  };
}
