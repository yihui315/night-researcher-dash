const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const dataSource = import("../functions/_lib/research/dataSource.mjs");
const snapshotStore = import("../functions/_lib/research/snapshotStore.mjs");
const strategyVersions = import("../functions/_lib/research/strategyVersions.mjs");
const split = import("../functions/_lib/research/split.mjs");
const performance = import("../functions/_lib/research/performance.mjs");
const anomaly = import("../functions/_lib/research/anomaly.mjs");

function tmpDir() {
  const dir = path.join(os.tmpdir(), "nr-research-test-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("snapshot ids are unique and stable across re-collection (append-only)", async () => {
  const { MockMarketDataSource } = await dataSource;
  const { collectSnapshot, loadSnapshots } = await snapshotStore;
  const dir = tmpDir();
  const source = new MockMarketDataSource({ seed: 1 });
  const ids = [];
  const from = Date.parse("2026-11-01T00:00:00.000Z");
  const step = 60 * 60 * 1000;
  for (let i = 0; i < 5; i++) {
    const r = await collectSnapshot(source, "BTCUSDT", { baseDir: dir, timestamp: from + i * step });
    ids.push(r.snapshot_id);
  }
  // re-collect the same 5 -> duplicates, same ids, no overwrite
  for (let i = 0; i < 5; i++) {
    const r = await collectSnapshot(source, "BTCUSDT", { baseDir: dir, timestamp: from + i * step });
    assert.equal(r.duplicate, true, "相同内容应标记为重复（不覆盖）");
    assert.equal(r.snapshot_id, ids[i], "重复采集应得到相同 id");
  }
  const all = await loadSnapshots({ baseDir: dir });
  assert.equal(all.length, 5, "不应因重复采集而产生多余文件");
  const uniqueIds = new Set(all.map(s => s.snapshot_id));
  assert.equal(uniqueIds.size, 5, "snapshot_id 必须唯一");
});

test("strategy version freeze computes a stable hash and reacts to param changes", async () => {
  const { freezeStrategyVersion, computeStrategyHash } = await strategyVersions;
  const a = freezeStrategyVersion({ id: "s1", version: "v1", params: { k: 1 } });
  const b = freezeStrategyVersion({ id: "s1", version: "v1", params: { k: 1 } });
  assert.equal(a.hash, b.hash, "相同输入必须得到相同哈希");
  assert.equal(a.hash, computeStrategyHash({ id: "s1", version: "v1", params: { k: 1 } }));
  const c = freezeStrategyVersion({ id: "s1", version: "v1", params: { k: 2 } });
  assert.notEqual(a.hash, c.hash, "参数变化必须改变哈希");
  assert.throws(() => freezeStrategyVersion({ id: "", version: "v1", params: {} }), /id/);
  assert.throws(() => freezeStrategyVersion({ id: "s1", version: "v1", params: [] }), /params/);
});

test("OOS isolation keeps train/validate and OOS date-disjoint", async () => {
  const { splitByDate, isOosIsolated } = await split;
  const mk = (date) => ({ snapshot_id: "x" + date, symbol: "BTCUSDT", timestampMs: Date.parse(date + "T12:00:00.000Z") });
  const snaps = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-03"].map(mk);
  const { train, validate, oos } = splitByDate(snaps, { trainEnd: "2026-11-01", validateEnd: "2026-11-02" });
  assert.equal(train.length, 1);
  assert.equal(validate.length, 1);
  assert.equal(oos.length, 2);
  assert.equal(isOosIsolated(snaps, { trainEnd: "2026-11-01", validateEnd: "2026-11-02" }), true);
  // dates must not overlap
  const trainDates = new Set(train.map(s => new Date(s.timestampMs).toISOString().slice(0, 10)));
  const oosDates = new Set(oos.map(s => new Date(s.timestampMs).toISOString().slice(0, 10)));
  for (const d of oosDates) assert.ok(!trainDates.has(d), "OOS 与训练集日期不可重叠");
});

test("performance math is correct for known small inputs", async () => {
  const { computePerformance } = await performance;
  const m = computePerformance({
    initialEquity: 10000,
    trades: [
      { symbol: "BTCUSDT", side: "BUY", entryPrice: 100, exitPrice: 110, qty: 1, fee: 1, slippage: 0.5 },
      { symbol: "BTCUSDT", side: "BUY", entryPrice: 100, exitPrice: 90, qty: 1, fee: 1, slippage: 0.5 }
    ]
  });
  assert.equal(m.totalTrades, 2);
  assert.equal(m.wins, 1);
  assert.equal(m.winRate, 0.5);
  assert.ok(Math.abs(m.profitLossRatio - 8.5 / 11.5) < 1e-9);
  assert.equal(m.fees, 2);
  assert.equal(m.slippage, 1);
  assert.equal(m.netPnl, -3);
  assert.ok(Math.abs(m.maxDrawdown - 11.5 / 10008.5) < 1e-9);
  assert.ok(Math.abs(m.sharpe - (-0.15)) < 1e-9);
});

test("performance uses fixed-point decimal for net pnl aggregation", async () => {
  const { computePerformance } = await performance;
  // many tiny pnl values that would drift under naive float summation
  const trades = [];
  for (let i = 0; i < 100; i++) trades.push({ side: "BUY", entryPrice: 1, exitPrice: 1.0001, qty: 1, fee: 0, slippage: 0 });
  const m = computePerformance({ trades });
  // 100 * (0.0001) = 0.01 exactly under fixed-point
  assert.ok(Math.abs(m.netPnl - 0.01) < 1e-9, "定点累加不应产生浮点漂移");
});

test("anomaly detection flags null prices and time gaps", async () => {
  const { detectAnomalies } = await anomaly;
  const snaps = [
    { snapshot_id: "a", symbol: "BTCUSDT", timestampMs: 1000, lastPrice: 100, bid: 99, ask: 101, volume24h: 10, orderBook: { bids: [[99, 1]], asks: [[101, 1]] } },
    { snapshot_id: "b", symbol: "BTCUSDT", timestampMs: 2000, lastPrice: null, bid: 99, ask: 101, volume24h: 10, orderBook: { bids: [[99, 1]], asks: [[101, 1]] } },
    { snapshot_id: "c", symbol: "BTCUSDT", timestampMs: 4000, lastPrice: 100, bid: 99, ask: 101, volume24h: 10, orderBook: { bids: [[99, 1]], asks: [[101, 1]] } }
  ];
  const anomalies = detectAnomalies(snaps, { expectedStepMs: 1000 });
  const types = anomalies.map(a => a.type);
  assert.ok(types.includes("missing_or_invalid_lastPrice"), "应检测 null 价格");
  assert.ok(types.includes("time_gap"), "应检测时间间隔缺口");
  // the clean snapshot must not raise a false positive
  assert.ok(!anomalies.some(a => a.snapshot_id === "a"), "健康快照不应误报");
});

test("end-to-end: collect, split, simulate, and compute real metrics on OOS", async () => {
  const { MockMarketDataSource, DEFAULT_SYMBOLS } = await dataSource;
  const { collectSeries, loadSnapshots } = await snapshotStore;
  const { splitByDate } = await split;
  const { simulateSampleTrades, computePerformance } = await performance;
  const dir = tmpDir();
  const source = new MockMarketDataSource({ seed: 42 });
  for (const sym of DEFAULT_SYMBOLS) {
    await collectSeries(source, sym, { baseDir: dir, fromIso: "2026-11-01T00:00:00.000Z", toIso: "2026-11-03T23:00:00.000Z", stepMs: 3600000 });
  }
  const all = await loadSnapshots({ baseDir: dir });
  assert.equal(all.length, 3 * 72, "应采集到 3 个交易对 × 72 小时");
  const { oos } = splitByDate(all, { trainEnd: "2026-11-01", validateEnd: "2026-11-02" });
  assert.equal(oos.length, 3 * 24, "OOS 应为 11-03 当天 24 小时 × 3");
  const trades = [];
  for (const sym of DEFAULT_SYMBOLS) {
    const prices = oos.filter(s => s.symbol === sym).map(s => s.lastPrice);
    trades.push(...simulateSampleTrades(prices, { symbol: sym, lookback: 5, feeRate: 0.001, slippageRate: 0.0005, qty: 1 }));
  }
  const m = computePerformance({ trades, sampleCount: oos.length });
  assert.ok(m.totalTrades >= 0);
  assert.ok(Number.isFinite(m.netPnl));
  assert.ok(Number.isFinite(m.winRate));
  assert.ok(m.maxDrawdown >= 0 && m.maxDrawdown <= 1, "回撤应在 0..1");
});
