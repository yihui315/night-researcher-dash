# -*- coding: utf-8 -*-
"""
BRC20 / RUNES 生态监测模块
=====================================================================
为什么用 Bitcoin 手续费做代理？
  BRC20（Ordinals 铭文，2023-03 起）与 RUNES（2024-04-20 减半激活）都是
  比特币 L1 上的同质化代币标准，**所有铸造/转账都消耗 BTC 手续费**。
  因此「Bitcoin 每日网络手续费」是这两类生态链上活跃度最好的公开代理指标。

数据可达性（实测 2026-10-31）：
  ✅ DefiLlama  Bitcoin 每日手续费（overview/fees?chain=Bitcoin）
  ✅ mempool.space  当前费率（sat/vB，实时拥堵读数）
  ❌ runes.today / unisat / brc20.com / CoinGecko  —— 本环境被墙，
     拿不到「代币级价格/成交量」，按 Prompt 规则标「未知」，绝不虚构。

结论属性：本模块输出的是「生态活跃度 / 拥堵」研究信号，
属事实(数据) + 推断(信号解读)分离，不构成任何买卖建议。
"""

import os
import json
import time
import datetime as dt

from backtest_engine import http_get_json, bj_time

DATADIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
FEES_CACHE = os.path.join(DATADIR, "btc_fees.json")
FEES_URL = "https://api.llama.fi/overview/fees?chain=Bitcoin"
MEMPOOL_URL = "https://mempool.space/api/v1/fees/recommended"
CACHE_MAX_AGE = 24 * 3600  # 缓存 24 小时

# 时代切分（UTC 秒）
BRC20_START = int(dt.datetime(2023, 3, 1, tzinfo=dt.timezone.utc).timestamp())
RUNES_START = int(dt.datetime(2024, 4, 20, tzinfo=dt.timezone.utc).timestamp())


def _fmt_money(x):
    if x >= 1e9:
        return f"${x/1e9:.2f}B"
    if x >= 1e6:
        return f"${x/1e6:.1f}M"
    if x >= 1e3:
        return f"${x/1e3:.0f}K"
    return f"${x:.0f}"


def fetch_btc_fees(force=False):
    """
    拉取 DefiLlama Bitcoin 每日手续费；优先用 <24h 的本地缓存，避免重复下载 ~28MB。
    返回 list[[ts, dailyFeesUSD]]，失败返回 []。
    """
    os.makedirs(DATADIR, exist_ok=True)
    if (not force) and os.path.exists(FEES_CACHE):
        age = time.time() - os.path.getmtime(FEES_CACHE)
        if age < CACHE_MAX_AGE:
            try:
                d = json.load(open(FEES_CACHE, encoding="utf-8"))
                return d.get("totalDataChart", [])
            except Exception:
                pass
    raw = http_get_json(FEES_URL)
    if raw and "totalDataChart" in raw:
        try:
            json.dump(raw, open(FEES_CACHE, "w", encoding="utf-8"))
        except Exception:
            pass
        return raw["totalDataChart"]
    # 网络失败但有旧缓存也能用
    if os.path.exists(FEES_CACHE):
        try:
            d = json.load(open(FEES_CACHE, encoding="utf-8"))
            return d.get("totalDataChart", [])
        except Exception:
            pass
    return []


def fetch_mempool_fees():
    """当前 BTC 费率（sat/vB）。失败返回 None。"""
    return http_get_json(MEMPOOL_URL)


def _era_mean(chart, start_ts, end_ts=None):
    vals = [p[1] for p in chart if p[0] >= start_ts and (end_ts is None or p[0] < end_ts)]
    return (sum(vals) / len(vals), len(vals)) if vals else (0.0, 0)


def analyze_brc20_runes():
    """
    产出 BRC20/RUNES 生态监测分析 dict：含 markdown 段落与关键事实。
    """
    chart = fetch_btc_fees()
    mempool = fetch_mempool_fees()

    if not chart:
        return {
            "ok": False,
            "markdown": ("## 五、BRC20 / RUNES 生态监测\n\n"
                         "- ⚠️ Bitcoin 手续费数据不可达，生态活跃度「未知」。\n"),
        }

    vals = [p[1] for p in chart]
    last_ts, last_fee = chart[-1]
    last_date = dt.datetime.fromtimestamp(last_ts, tz=dt.timezone.utc).strftime("%Y-%m-%d")

    # 近期均值
    def avg_last(n):
        sub = vals[-n:]
        return sum(sub) / len(sub) if sub else 0.0
    avg30 = avg_last(30)
    avg90 = avg_last(90)
    avg365 = avg_last(365)

    # 分位（当前在最近 365 天中的位置）
    window365 = vals[-365:]
    pct_365 = (sum(1 for v in window365 if v <= last_fee) / len(window365)) if window365 else 0.0

    # 时代均值
    mean_pre, n_pre = _era_mean(chart, 0, BRC20_START)
    mean_brc20, n_brc20 = _era_mean(chart, BRC20_START, RUNES_START)
    mean_runes, n_runes = _era_mean(chart, RUNES_START)

    # 活跃波动：最近 90 天中，单日手续费 > 365 天均值 2 倍的"活跃峰值"天数
    spikes90 = sum(1 for p in chart[-90:] if p[1] > 2 * avg365) if avg365 else 0

    # 当前拥堵分级（mempool 实时费率）
    congestion = "未知"
    fast = None
    if mempool and isinstance(mempool, dict):
        fast = mempool.get("fastestFee") or mempool.get("halfHourFee")
        if fast is None:
            fast = mempool.get("hourFee")
    if fast is not None:
        if fast <= 3:
            congestion = "极闲（~1–3 sat/vB，链上冷清）"
        elif fast <= 15:
            congestion = "正常"
        elif fast <= 50:
            congestion = "偏忙"
        else:
            congestion = "拥堵（铭文/符文铸造潮典型特征）"

    # —— 信号解读（明确标注为推断）——
    trend_word = "高于" if last_fee >= avg365 else "低于"
    if fast is not None and fast <= 15 and last_fee <= avg365:
        congestion_note = ("当前瞬时费率低且日均手续费低于年均，链上整体清淡，"
                          "BRC20/RUNES 投机/铸造活动处于低位")
    elif fast is not None and fast <= 15 and last_fee > avg365:
        congestion_note = (f"当前瞬时费率仅 {fast} sat/vB（极闲），但日均手续费处近一年 {pct_365*100:.0f}% 高位——"
                          "高位更多来自 BTC 价格与基线活动，而非当前铭文/符文铸造潮的瞬时拥堵，"
                          "BRC20/RUNES 当下并不火热")
    elif fast is not None:
        congestion_note = (f"当前费率 {fast} sat/vB（{congestion}），链上活跃度偏高，"
                          "需关注 BRC20/RUNES 是否再现铸造潮")
    else:
        congestion_note = "mempool 费率未知"

    signal = (f"推断：当前 BTC 单日手续费 {_fmt_money(last_fee)}，{trend_word}过去一年均值 "
              f"({_fmt_money(avg365)})，处于近一年 {pct_365*100:.0f}% 分位。"
              f"RUNES 时代(2024-04-20 起)日均手续费 {_fmt_money(mean_runes)}，"
              f"较 BRC20 时代(2023-03 起)的 {_fmt_money(mean_brc20)} "
              f"{'上升' if mean_runes>mean_brc20 else '下降'}。"
              f"近 90 天出现 {spikes90} 个『活跃峰值日』(>年均2倍)。"
              f"{congestion_note}。"
              f"——以上为基于 L1 手续费的推断，非代币价格结论。")

    md = []
    md.append("## 五、BRC20 / RUNES 生态监测（基于 Bitcoin L1 手续费代理）")
    md.append("")
    md.append("> 说明：BRC20 与 RUNES 均在比特币 L1 铸造/转账，消耗 BTC 手续费；"
              "本环境无法直连 runes.today / unisat / brc20.com / CoinGecko 获取代币级价格，"
              "故以 **Bitcoin 每日网络手续费** 作为生态活跃度代理。")
    md.append("")
    md.append("### 5.1 关键事实（数据）")
    md.append("")
    md.append("| 指标 | 数值 | 来源 |")
    md.append("|---|---|---|")
    md.append(f"| 数据区间 | 2018-03-26 ~ {last_date}（{len(chart)} 天） | DefiLlama |")
    md.append(f"| 最近一日 BTC 手续费 | {_fmt_money(last_fee)} | DefiLlama |")
    md.append(f"| 近 30 日均值 | {_fmt_money(avg30)} | 计算 |")
    md.append(f"| 近 90 日均值 | {_fmt_money(avg90)} | 计算 |")
    md.append(f"| 近 365 日均值 | {_fmt_money(avg365)} | 计算 |")
    md.append(f"| 当前处于近一年分位 | {pct_365*100:.0f}% | 计算 |")
    md.append(f"| 当前 mempool 费率 | {fast} sat/vB（{congestion}） | mempool.space |")
    md.append(f"| 近 90 天活跃峰值日(>年均2倍) | {spikes90} 天 | 计算 |")
    md.append("")
    md.append("### 5.2 时代对比（BRC20 vs RUNES）")
    md.append("")
    md.append("| 时代 | 区间 | 日均手续费 | 天数 |")
    md.append("|---|---|---|---|")
    md.append(f"| 前 BRC20 时代 | 2018-03 ~ 2023-02 | {_fmt_money(mean_pre)} | {n_pre} |")
    md.append(f"| BRC20 时代 | 2023-03 ~ 2024-04-19 | {_fmt_money(mean_brc20)} | {n_brc20} |")
    md.append(f"| RUNES 时代 | 2024-04-20 ~ 今 | {_fmt_money(mean_runes)} | {n_runes} |")
    md.append("")
    md.append("### 5.3 信号解读（推断，非投资建议）")
    md.append("")
    md.append(f"- {signal}")
    md.append("- ⚠️ 本代理无法区分 BRC20 与 RUNES 各自贡献，也无法反映单个代币涨跌；"
              "若需代币级研究，请在可访问 CoinGecko / UniSat / Dune 的环境补充价格接口。")
    md.append("")

    return {
        "ok": True,
        "markdown": "\n".join(md),
        "facts": {
            "last_fee": last_fee, "avg30": avg30, "avg90": avg90, "avg365": avg365,
            "pct_365": pct_365, "fast": fast, "congestion": congestion,
            "spikes90": spikes90,
            "mean_pre": mean_pre, "n_pre": n_pre,
            "mean_brc20": mean_brc20, "n_brc20": n_brc20,
            "mean_runes": mean_runes, "n_runes": n_runes,
        },
    }


if __name__ == "__main__":
    r = analyze_brc20_runes()
    print(r["markdown"])
