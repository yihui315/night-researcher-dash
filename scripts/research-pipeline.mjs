#!/usr/bin/env node
// Quant research data pipeline (offline, deterministic).
//
// 1. Pull snapshots from the pluggable data source (MOCK by default; swap for a real source later).
// 2. Persist them append-only under data/market_snapshots/<SYMBOL>/ (unique snapshot_id each).
// 3. Freeze a strategy version (id + version + params + hash).
// 4. Isolate train / validate / OOS by DATE.
// 5. Simulate deterministic sample trades from the OOS price series and compute REAL metrics.
// 6. Run anomaly detection and emit reports/RESEARCH_DAILY_<date>.md.
//
// Everything here is reproducible and offline — no exchange, no network, no fabricated numbers.

import path from "node:path";
import { MockMarketDataSource, DEFAULT_SYMBOLS } from "../functions/_lib/research/dataSource.mjs";
import {
  collectSeries,
  loadSnapshots
} from "../functions/_lib/research/snapshotStore.mjs";
import {
  freezeStrategyVersion,
  saveFrozenVersion
} from "../functions/_lib/research/strategyVersions.mjs";
import { splitByDate } from "../functions/_lib/research/split.mjs";
import {
  computePerformance,
  simulateSampleTrades
} from "../functions/_lib/research/performance.mjs";
import { detectAnomalies } from "../functions/_lib/research/anomaly.mjs";
import { writeDailyReport } from "../functions/_lib/research/report.mjs";

const BASE_DIR = path.resolve(process.cwd(), "data", "market_snapshots");
const STEP_MS = 60 * 60 * 1000; // hourly sampling
const FROM = "2026-11-01T00:00:00.000Z";
const TO = "2026-11-03T23:00:00.000Z";
// Date-based isolation: 11-01 train, 11-02 validate, 11-03 OOS.
const SPLIT_CONFIG = { trainEnd: "2026-11-01", validateEnd: "2026-11-02" };
const REPORT_DATE = "2026-11-03";

const STRATEGY = { id: "mean-reversion-sma5", version: "v1.0.0", params: { lookback: 5, entryThreshold: 0.997, feeRate: 0.001, slippageRate: 0.0005 } };

async function main() {
  const source = new MockMarketDataSource({ symbols: DEFAULT_SYMBOLS, seed: 20261103 });

  // 1+2. Collect snapshots (append-only).
  const collected = {};
  for (const symbol of DEFAULT_SYMBOLS) {
    const results = await collectSeries(source, symbol, { baseDir: BASE_DIR, fromIso: FROM, toIso: TO, stepMs: STEP_MS });
    collected[symbol] = results.length;
  }
  console.log("[pipeline] 已采集快照:", collected);

  // 3. Freeze strategy version.
  const frozen = freezeStrategyVersion(STRATEGY);
  await saveFrozenVersion(frozen);
  console.log("[pipeline] 策略版本已冻结:", frozen.id, frozen.version, frozen.hash);

  // Load back and split by date.
  const all = await loadSnapshots({ baseDir: BASE_DIR });
  const { train, validate, oos } = splitByDate(all, SPLIT_CONFIG);
  console.log(`[pipeline] 样本划分: train=${train.length} validate=${validate.length} oos=${oos.length}`);

  // 5. Simulate sample trades on the OOS series per symbol, then compute real metrics.
  const oosBySymbol = {};
  for (const s of oos) (oosBySymbol[s.symbol] ||= []).push(s);
  let trades = [];
  const oosPricesBySymbol = {};
  for (const symbol of DEFAULT_SYMBOLS) {
    const series = (oosBySymbol[symbol] || []).slice().sort((a, b) => a.timestampMs - b.timestampMs);
    const prices = series.map(s => s.lastPrice);
    oosPricesBySymbol[symbol] = prices;
    trades = trades.concat(simulateSampleTrades(prices, { symbol, ...STRATEGY.params }));
  }
  const metrics = computePerformance({ trades, sampleCount: oos.length, initialEquity: 10000, riskRejections: 0, strategyDeactivations: 0 });
  console.log("[pipeline] OOS 绩效:", {
    totalTrades: metrics.totalTrades, winRate: metrics.winRate.toFixed(3),
    netPnl: metrics.netPnl.toFixed(4), maxDrawdown: metrics.maxDrawdown.toFixed(4), sharpe: metrics.sharpe.toFixed(4)
  });

  // 6. Anomaly detection (expected hourly step).
  const anomalies = detectAnomalies(all, { expectedStepMs: STEP_MS });
  console.log(`[pipeline] 异常检测: ${anomalies.length} 处`);

  // Report.
  const reportFile = await writeDailyReport({
    date: REPORT_DATE,
    strategy: frozen,
    metrics,
    anomalies,
    snapshotCounts: collected,
    splits: { train: train.length, validate: validate.length, oos: oos.length }
  });
  console.log("[pipeline] 报告已生成:", reportFile);

  return { collected, frozen, splits: { train: train.length, validate: validate.length, oos: oos.length }, metrics, anomalies, reportFile };
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
