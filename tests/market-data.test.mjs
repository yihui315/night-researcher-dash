// tests/market-data.test.mjs — 行情采集离线验收（T05 / P1-1）
//
// 通过注入 mock fetchImpl 模拟 Binance / OKX 公共响应，验证：
//   - 归一化正确（OHLCV / 成交 / 盘口）
//   - 原始数据校验值（SHA256）生成
//   - 数据缺失标记（missingFlag）在部分失败时被正确标记
//   - 第二数据源交叉验证逻辑
// 运行：node --test tests/market-data.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSymbol,
  collectSnapshot,
  normalizeBinanceKline,
  crossValidate,
} from "../functions/_lib/market-data/collector.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "binance-mock.json"), "utf8"));

// mock fetchImpl：按 URL 关键字返回对应 fixture
function mockFetch() {
  return async (url) => {
    if (url.includes("/klines")) return { ok: true, json: async () => fx.klines };
    if (url.includes("/trades")) return { ok: true, json: async () => fx.trades };
    if (url.includes("/depth")) return { ok: true, json: async () => fx.depth };
    if (url.includes("okx.com")) return { ok: true, json: async () => ({ code: "0", data: fx.okxCandles }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test("normalizeBinanceKline: 字段映射正确", () => {
  const k = normalizeBinanceKline(fx.klines[0]);
  assert.equal(k.openTime, 1700000000000);
  assert.equal(k.open, "30000.0");
  assert.equal(k.high, "30010.0");
  assert.equal(k.low, "29990.0");
  assert.equal(k.close, "30005.0");
  assert.equal(k.volume, "12.5");
});

test("crossValidate: 价差在阈值内 → matched", () => {
  const r = crossValidate("30005.0", "30006.5", 0.005);
  assert.equal(r.matched, true);
  assert.ok(r.spreadRatio <= 0.005);
});

test("crossValidate: 价差超阈值 → matched=false", () => {
  const r = crossValidate("30005.0", "31000.0", 0.005);
  assert.equal(r.matched, false);
});

test("collectSymbol: 完整采集（含交叉验证）→ 无 missingFlag", async () => {
  const rec = await collectSymbol("BTCUSDT", { fetchImpl: mockFetch(), crossValidate: true });
  assert.equal(rec.exchange, "binance");
  assert.equal(rec.symbol, "BTCUSDT");
  assert.equal(rec.ohlcv.close, "30005.0");
  assert.equal(rec.lastTrades.length, 2);
  assert.equal(rec.orderbook.bids.length, 2);
  assert.ok(typeof rec.rawChecksum === "string" && rec.rawChecksum.length === 64); // SHA256 hex
  assert.equal(rec.eventTime, 1700000059999);
  assert.ok(rec.recvTime > 0);
  assert.ok(rec.crossValidation && rec.crossValidation.matched === true);
  assert.deepEqual(rec.missingFlag, {});
});

test("collectSymbol: 部分数据源失败 → missingFlag 标记", async () => {
  // 仅 klines 成功，trades/depth/okx 全部失败
  const failing = async (url) => {
    if (url.includes("/klines")) return { ok: true, json: async () => fx.klines };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const rec = await collectSymbol("ETHUSDT", { fetchImpl: failing, crossValidate: true });
  assert.ok(rec.ohlcv); // klines 成功
  assert.equal(rec.lastTrades, null);
  assert.ok(rec.missingFlag.trades);
  assert.ok(rec.missingFlag.depth);
  assert.ok(rec.missingFlag.secondSource);
});

test("collectSnapshot: 多标的聚合 + 完整性汇总", async () => {
  const snap = await collectSnapshot(["BTCUSDT", "ETHUSDT", "ORDIUSDT"], {
    fetchImpl: mockFetch(),
    crossValidate: true,
  });
  assert.equal(snap.records.length, 3);
  assert.equal(snap.symbols.length, 3);
  assert.equal(snap.complete, true);
  assert.equal(snap.primary, "binance");
  assert.equal(snap.secondary, "okx");
  for (const r of snap.records) {
    assert.deepEqual(r.missingFlag, {});
  }
});
