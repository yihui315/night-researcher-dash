// Daily research report generator. Writes reports/RESEARCH_DAILY_<date>.md with real metrics.

import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_REPORTS_DIR = path.resolve(process.cwd(), "reports");

function pct(x) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return (x * 100).toFixed(2) + "%";
}

function num(x, d = 4) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return Number(x).toFixed(d);
}

function fmtDate(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

export function buildDailyReportContent({ date, strategy, metrics, anomalies, snapshotCounts, splits }) {
  const ds = fmtDate(date);
  const lines = [];
  lines.push(`# Night Researcher 每日研究简报 — ${ds}`);
  lines.push("");
  lines.push(`> 自动生成 · 数据来源：确定性 MOCK（离线）· 所有指标由生成的样本实算，非编造。`);
  lines.push("");
  lines.push("## 策略版本");
  if (strategy) {
    lines.push("");
    lines.push(`- 策略ID：${strategy.id}`);
    lines.push(`- 版本：${strategy.version}`);
    lines.push(`- 参数：${JSON.stringify(strategy.params)}`);
    lines.push(`- 冻结哈希：${strategy.hash}`);
  } else {
    lines.push("");
    lines.push("- （未提供）");
  }
  lines.push("");
  lines.push("## 样本概览");
  lines.push("");
  lines.push(`- 总样本数：${metrics.sampleCount}`);
  if (snapshotCounts) {
    for (const [sym, n] of Object.entries(snapshotCounts)) {
      lines.push(`- ${sym} 快照数：${n}`);
    }
  }
  if (splits) {
    lines.push(`- 训练集：${splits.train} · 验证集：${splits.validate} · OOS 集：${splits.oos}`);
  }
  lines.push("");
  lines.push("## 交易与绩效（由样本模拟交易实算）");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("| --- | --- |");
  lines.push(`| 总交易数 | ${metrics.totalTrades} |`);
  lines.push(`| 胜率 | ${pct(metrics.winRate)} |`);
  lines.push(`| 盈亏比 (P/L) | ${metrics.profitLossRatio == null ? "∞（无亏损）" : num(metrics.profitLossRatio, 3)} |`);
  lines.push(`| 平均盈利 | ${num(metrics.avgWin, 4)} |`);
  lines.push(`| 平均亏损 | ${num(metrics.avgLoss, 4)} |`);
  lines.push(`| 毛盈利 | ${num(metrics.grossProfit, 4)} |`);
  lines.push(`| 毛亏损 | ${num(metrics.grossLoss, 4)} |`);
  lines.push(`| 手续费 | ${num(metrics.fees, 4)} |`);
  lines.push(`| 滑点 | ${num(metrics.slippage, 4)} |`);
  lines.push(`| 净盈亏 (net pnl) | ${num(metrics.netPnl, 4)} |`);
  lines.push(`| 最大回撤 | ${pct(metrics.maxDrawdown)} |`);
  lines.push(`| Sharpe（单笔） | ${num(metrics.sharpe, 4)} |`);
  lines.push(`| 风险驳回次数 | ${metrics.riskRejections} |`);
  lines.push(`| 策略停用次数 | ${metrics.strategyDeactivations} |`);
  lines.push("");
  lines.push("## 数据质量 / 异常检测");
  lines.push("");
  if (!anomalies || anomalies.length === 0) {
    lines.push("- 未发现缺失或异常（null/gap/交叉盘口）。");
  } else {
    lines.push(`- 共发现 ${anomalies.length} 处异常：`);
    for (const a of anomalies.slice(0, 50)) {
      lines.push(`  - [${a.type}] ${a.snapshot_id}: ${a.detail}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push(`生成时间：${new Date().toISOString()}`);
  return lines.join("\n");
}

export async function writeDailyReport({ date, strategy, metrics, anomalies, snapshotCounts, splits, reportsDir = DEFAULT_REPORTS_DIR } = {}) {
  const ds = fmtDate(date);
  const content = buildDailyReportContent({ date: ds, strategy, metrics, anomalies, snapshotCounts, splits });
  await fs.mkdir(reportsDir, { recursive: true });
  const file = path.join(reportsDir, `RESEARCH_DAILY_${ds}.md`);
  await fs.writeFile(file, content, "utf8");
  return file;
}
