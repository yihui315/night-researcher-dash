// scripts/market-collect.mjs — 行情采集 CLI（T05 / P1-1）
//
// 用法：
//   node scripts/market-collect.mjs                 # 真实采集 BTCUSDT/ETHUSDT/ORDIUSDT（需网络可达 Binance/OKX）
//   node scripts/market-collect.mjs --symbols BTCUSDT,ETHUSDT
//   node scripts/market-collect.mjs --offline        # 用样例 fixture 离线回放（无需网络）
//   node scripts/market-collect.mjs --out data/market/snapshot.json
//
// 注意：仅采集公共行情，不持有任何交易 Key，绝不下单。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSnapshot } from "../functions/_lib/market-data/collector.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

const offline = args.includes("--offline");
const symbols = (get("--symbols") || "BTCUSDT,ETHUSDT,ORDIUSDT").split(",").map((s) => s.trim());
const out = get("--out");
const interval = get("--interval", "1m");

async function main() {
  let fetchImpl = fetch;
  if (offline) {
    const fx = JSON.parse(
      readFileSync(join(root, "tests/fixtures/binance-mock.json"), "utf8"),
    );
    fetchImpl = async (url) => {
      if (url.includes("/klines")) return { ok: true, json: async () => fx.klines };
      if (url.includes("/trades")) return { ok: true, json: async () => fx.trades };
      if (url.includes("/depth")) return { ok: true, json: async () => fx.depth };
      if (url.includes("okx.com")) return { ok: true, json: async () => ({ code: "0", data: fx.okxCandles }) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
  }

  console.log(`采集模式: ${offline ? "离线回放" : "真实网络"} | 标的: ${symbols.join(",")} | 周期: ${interval}`);
  const snap = await collectSnapshot(symbols, { interval, fetchImpl });
  const json = JSON.stringify(snap, null, 2);
  if (out) {
    const p = join(root, out);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, json);
    console.log(`已写入: ${p}`);
  } else {
    console.log(json);
  }
  const incomplete = snap.records.filter((r) => Object.keys(r.missingFlag).length);
  if (incomplete.length) {
    console.error(`⚠️ ${incomplete.length} 个标的存在数据缺失: ${incomplete.map((r) => r.symbol).join(", ")}`);
    process.exitCode = 2;
  } else {
    console.log("✅ 全部标的采集完整（含交叉验证）。");
  }
}

main().catch((e) => {
  console.error("采集失败:", e.message);
  process.exit(1);
});
