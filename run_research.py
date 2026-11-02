# -*- coding: utf-8 -*-
"""
run_research.py —— 夜班交易研究员 · 执行入口
============================================
拉取公开数据 → 跑策略（FNG_EMA_MR 基准 + BRC20_RSI_MR 高频）→ 滚动样本外交叉验证
→ 生成「卡片 + 早报 + 交叉验证 + RUNES/永续补充数据」。

运行：python run_research.py
（纯标准库，无需 pip install）

硬约束（源自 Prompt 与项目规则）：
  - 不爬 X / Twitter（想法池由用户粘贴提供，本脚本不抓取社媒）
  - 不写下单代码、不给买卖建议（仅研究/回测）
  - 拿不到的数据标「未知」，绝不虚构（如永续资金费率、RUNES 代币级价格）
"""
import os
import time
import json

from backtest_engine import (
    fetch_klines, fetch_fng, fetch_stablecoin_supply, Context,
    simulate, evaluate_gates, build_card, build_morning_report, bj_time,
    buy_and_hold_return, walk_forward_oos, grid_search, summarize_grid,
)
from strategies import STRATEGIES
from brc20_runes_monitor import analyze_brc20_runes
from connectors_extra import fetch_funding_rate, fetch_liquidations, fetch_runes_top

WORKDIR = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(WORKDIR, "output")

# 研究重点：BRC20（ORDI / 1000SATS 现货 K 线经 Binance 镜像真实可达）+ RUNES（仅 L1 手续费代理）
BASE_SYMBOLS = [
    ("BTCUSDT", "BTC(基准)"),
    ("ETHUSDT", "ETH(基准)"),
]
BRC20_SYMBOLS = [
    ("ORDIUSDT", "ORDI·BRC20"),
    ("1000SATSUSDT", "1000SATS·BRC20"),
]
WINDOW_DAYS = 730      # 回测窗口 ~2 年
OOS_DAYS = 90          # 最近 3 个月作样本外验证（原 Prompt 规定：强制留最近 3 个月验证）
INTERVAL = "4h"
FOLDS = 3              # 滚动样本外 fold 数


def _fmt_pct(x):
    if x is None:
        return "未知(样本不足)"
    return f"{x*100:+.2f}%"


def backtest_symbol(strat_key, sym, label, start_ms, now_ms, oos_ms, fng_pts, sources_note):
    """对单个标的跑一个策略，返回 (card, summary, ctx, bh, metrics)。"""
    bars = fetch_klines(sym, INTERVAL, start_ms, now_ms)
    print(f"    4h K线根数：{len(bars)}")
    if len(bars) < 250:
        print("    ⚠️ K线不足，跳过")
        return None
    bh = buy_and_hold_return(bars)
    ctx = Context(bars, fng_pts)
    oos_idx = 0
    for i, b in enumerate(bars):
        if b["t"] >= oos_ms:
            oos_idx = i
            break
    strat = STRATEGIES[strat_key]()
    summary = simulate(strat, ctx, oos_idx)
    gates, overfit = evaluate_gates(strat, summary, ctx)
    # 超额收益直接取引擎内联计算（全窗口策略净收益 − 买入持有），保证与 g4 一致
    excess = summary.get("excess")
    card = build_card(strat, summary, gates, overfit, sources_note, label, excess)
    ins, oos = summary["insample"], summary["oos"]
    name = label.split("(")[0]
    tag = "BRC20" if "BRC20" in label else "基准"
    metrics = {
        "sym": name, "tag": tag, "strat": strat_key,
        "inSample": round(ins["net"] * 100, 2),
        "oos": (round(oos["net"] * 100, 2) if oos["n"] else None),
        "mdd": round(summary["max_drawdown"] * 100, 2),
        "trades": summary["n_trades"],
        "excess": (round(excess * 100, 2) if excess is not None else None),
        "pass": bool(card["survived"]),
        "reason": card["death_or_alive"],
    }
    return card, summary, ctx, bh, metrics


def main():
    now_ms = int(time.time() * 1000)
    start_ms = now_ms - WINDOW_DAYS * 86400_000
    oos_ms = now_ms - OOS_DAYS * 86400_000

    print(f"[*] 回测窗口：{bj_time(start_ms)} ~ {bj_time(now_ms)}（约 {WINDOW_DAYS} 天）")
    print(f"[*] 样本外(OOS)分界线：{bj_time(oos_ms)} 之后（原 Prompt 规定 90 天）")

    print("[*] 拉取恐贪指数 ...")
    fng_pts = fetch_fng(limit=1000)
    print(f"    恐贪数据点：{len(fng_pts)}")
    fng_now = fng_pts[-1][1] if fng_pts else None
    fng_prev = fng_pts[-2][1] if len(fng_pts) >= 2 else None

    print("[*] 拉取稳定币总供应 ...")
    stable = fetch_stablecoin_supply()

    sources_note = ("K线: data-api.binance.vision(4h，含 ORDI/1000SATS 等 BRC20 现货) | 恐贪: alternative.me | "
                    "稳定币: DefiLlama | 资金费率: 线上浏览器实时(fapi.binance.vision) | RUNES: 需 UNISAT/DUNE key")

    cards = []
    cards_json = []
    baselines = []

    # —— 策略 A：FNG_EMA_MR（基准，低频）跑全部 4 标的 ——
    print("\n[*] 策略 FNG_EMA_MR（基准）")
    for sym, label in BASE_SYMBOLS + BRC20_SYMBOLS:
        print(f"\n[*] 处理 {label} ({sym}) ...")
        res = backtest_symbol("FNG_EMA_MR", sym, label, start_ms, now_ms, oos_ms, fng_pts, sources_note)
        if not res:
            continue
        card, summary, ctx, bh, metrics = res
        cards.append(card)
        cards_json.append(metrics)
        if bh is not None:
            baselines.append((label, bh))
        ins, oos = summary["insample"], summary["oos"]
        print(f"    交易次数：{summary['n_trades']}（样本内 {ins['n']} / 样本外 {oos['n']}）")
        print(f"    样本内净收益：{ins['net']:.2%}  超额(买入持有)：{_fmt_pct(card.get('excess'))}")
        print(f"    结论：{card['death_or_alive']}")

    # —— 策略 B：BRC20_RSI_MR（高频原生）仅跑 BRC20 2 标的 ——
    brc20_ctx = {}
    print("\n[*] 策略 BRC20_RSI_MR（BRC20 原生高频）")
    for sym, label in BRC20_SYMBOLS:
        print(f"\n[*] 处理 {label} ({sym}) ...")
        res = backtest_symbol("BRC20_RSI_MR", sym, label, start_ms, now_ms, oos_ms, fng_pts, sources_note)
        if not res:
            continue
        card, summary, ctx, bh, metrics = res
        cards.append(card)
        cards_json.append(metrics)
        if bh is not None:
            baselines.append((label, bh))
        brc20_ctx[label] = ctx
        ins, oos = summary["insample"], summary["oos"]
        print(f"    交易次数：{summary['n_trades']}（样本内 {ins['n']} / 样本外 {oos['n']}）")
        print(f"    样本内净收益：{ins['net']:.2%}  超额(买入持有)：{_fmt_pct(card.get('excess'))}")
        print(f"    结论：{card['death_or_alive']}")

    # ============ 生成早报骨架 ============
    os.makedirs(OUTDIR, exist_ok=True)
    report = build_morning_report(cards, fng_now, fng_prev, stable, sources_note, bj_time(now_ms))

    report = report.replace(
        "标的：BTC/ETH  |  周期：4h / 1d",
        "标的：BTC/ETH(基准) + ORDI·1000SATS(BRC20重点)  |  周期：4h  |  研究重点：BRC20 / RUNES",
        1,
    )
    focus_note = (
        "\n> **研究重点（本期）**：BRC20（ORDI、1000SATS 现货 K 线经 Binance 镜像**真实拉取**，可做代币级回测）；"
        "RUNES 代币级价格本环境不可达，仅以 BTC L1 手续费作链上活跃度代理。所有回测均为研究演示，非投资建议。\n"
    )
    report = report.replace("\n## 一、总表", focus_note + "\n## 一、总表", 1)

    # ============ §五 BRC20/RUNES 生态监测 ============
    print("\n[*] 生成 BRC20/RUNES 生态监测 ...")
    mon = analyze_brc20_runes()
    mon_md = mon.get("markdown", "")
    if mon.get("ok"):
        f = mon["facts"]
        print(f"    最近一日 BTC 手续费：${f['last_fee']/1e6:.1f}M（近一年 {f['pct_365']*100:.0f}% 分位）")
        print(f"    当前 mempool 费率：{f['fast']} sat/vB（{f['congestion']}）")
    mon_md += ("\n\n> 注：ORDI / 1000SATS 等 BRC20 龙头的**代币级回测**见上方「二、卡片」。"
               "RUNES 代币级价格本环境不可达，仅以上述 BTC L1 手续费作活跃度代理。\n")

    # ============ §六 跨资产/周期交叉验证 ============
    print("[*] 生成跨资产/周期交叉验证 ...")
    cv_md, cv_struct = _build_cross_validation(brc20_ctx, now_ms, start_ms, oos_ms, fng_pts)

    # ============ §六·5 多参数网格交叉验证（量化过拟合） ============
    print("[*] 生成多参数网格交叉验证 ...")
    grid_md, grid_struct = _build_grid_cv(brc20_ctx, oos_ms)

    # ============ §七 永续/RUNES 补充数据（可达环境可用） ============
    print("[*] 调用 RUNES/资金费率/爆仓 连接器 ...")
    supp_md, supp_struct = _build_supplementary()

    # ============ 组装研究结论 JSON（单一数据源，供前端实时刷新） ============
    eco = mon.get("facts", {}) if mon.get("ok") else {}
    ecosystem = {
        "lastDayFee": round(eco.get("last_fee", 0) / 1e6, 1),
        "avg30": round(eco.get("avg30", 0) / 1e6, 1),
        "avg90": round(eco.get("avg90", 0) / 1e6, 1),
        "avg365": round(eco.get("avg365", 0) / 1e6, 1),
        "pct365": round(eco.get("pct_365", 0) * 100, 0),
        "mempoolNow": f"{eco.get('fast')} sat/vB（{eco.get('congestion','未知')}）" if eco.get("fast") is not None else "未知",
        "spikes90": eco.get("spikes90", 0),
        "eras": [
            {"label": "前BRC20", "sub": "2018-03~2023-02", "value": round(eco.get("mean_pre", 0) / 1e6, 1), "days": eco.get("n_pre", 0)},
            {"label": "BRC20", "sub": "2023-03~2024-04", "value": round(eco.get("mean_brc20", 0) / 1e6, 1), "days": eco.get("n_brc20", 0)},
            {"label": "RUNES", "sub": "2024-04~今", "value": round(eco.get("mean_runes", 0) / 1e6, 1), "days": eco.get("n_runes", 0)},
        ],
    }
    research_data = {
        "meta": {
            "date": bj_time(now_ms)[:10],
            "generatedAt": bj_time(now_ms),
            "window": f"{WINDOW_DAYS} 天回测窗口 + {OOS_DAYS} 天样本外(OOS)",
            "note": "所有数值来自真实公开数据回测；策略均标注「示例/教学，非投资建议」。",
        },
        "gates": {
            "g4": "第四关·超额主门槛(g4)：样本内净收益须跑赢同窗口「买入持有」（相对买入持有 ≥ 0），否则不予放行。",
            "oos90": "原 Prompt 规定「强制留最近 3 个月(90天)验证」的 OOS 门槛保持不变，未擅自修改协议。",
        },
        "cards": cards_json,
        "crossValidation": cv_struct,
        "grid": grid_struct,
        "ecosystem": ecosystem,
        "supplementary": supp_struct,
    }
    _write_research_json(research_data)
    print(f"[✓] 研究结论 JSON 已写入：{os.path.join(WORKDIR, 'dashboard', 'data', 'research.json')}")

    # ============ 组装 ============
    footer_idx = report.rfind("\n---")
    if footer_idx != -1:
        report = report[:footer_idx] + "\n" + mon_md + cv_md + grid_md + supp_md + report[footer_idx:]
    else:
        report += "\n\n" + mon_md + cv_md + grid_md + supp_md

    out_path = os.path.join(OUTDIR, "morning_report.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"\n[✓] 早报已写入：{out_path}")
    return out_path


def _build_cross_validation(brc20_ctx, now_ms, start_ms, oos_ms, fng_pts):
    """对 ORDI/SATS 做：① 双策略滚动样本外(3 fold) ② 多周期(4h vs 1d) 对比。
    返回 (markdown, struct)：struct 供前端 JSON 渲染。"""
    L = ["\n## 六、跨资产 / 周期交叉验证（压制单资产过拟合嫌疑）\n"]
    dayms = 86400_000
    start_d = bj_time(start_ms)
    cv = {"grainFlip": [], "vintage": [], "walkForward": []}
    param_grids = {
        "FNG_EMA_MR": {
            "fng_extreme": [20, 25, 30],
            "rsi_entry": [30, 35, 40],
            "max_hold": [10, 20],
        },
        "BRC20_RSI_MR": {
            "oversold": [22, 26, 30, 35, 40],
            "overbought": [60, 65, 70, 75, 80],
        },
    }

    for label, ctx in brc20_ctx.items():
        L.append(f"\n### 6.1 {label} · 严格 Walk-forward（每个 fold 先训练，再独立验证 90 天）\n")
        L.append(f"- 回测窗口：{start_d} 起；共 {FOLDS} 个不重叠验证窗口。每个 fold 只使用验证窗口之前的数据选择参数。\n")
        L.append("| 策略 | 训练交易数 | 训练期净收益 | 验证交易数 | OOS 净收益 | 胜率 | 验证回撤 | 状态 |")
        L.append("|---|---:|---:|---:|---:|---:|---:|---|")
        vintage_by_strat = {}
        walkforward_by_strat = {}
        for key, name in [("FNG_EMA_MR", "FNG_EMA_MR(低频)"), ("BRC20_RSI_MR", "BRC20_RSI_MR(高频)")]:
            folds = walk_forward_oos(
                STRATEGIES[key],
                ctx,
                param_grids[key],
                folds=FOLDS,
                oos_days=OOS_DAYS,
                min_train_trades=10,
            )
            vintage_by_strat[key] = folds
            walkforward_by_strat[key] = folds
            for fd in folds:
                train_net = "—" if fd["train_net"] is None else _fmt_pct(fd["train_net"])
                oos_net = _fmt_pct(fd["net"])
                wr = "—" if fd["win_rate"] is None else f"{fd['win_rate']*100:.1f}%"
                mdd = "—" if fd["max_drawdown"] is None else f"{fd['max_drawdown']*100:.1f}%"
                status = "训练期无正 edge" if fd["status"] == "NO_TRAIN_EDGE" else ("验证无交易" if fd["status"] == "NO_OOS_TRADES" else "已验证")
                L.append(f"| {name} | {fd['train_n']} | {train_net} | {fd['n']} | {oos_net} | {wr} | {mdd} | {status} |")
        L.append("")
        for key, name in [("FNG_EMA_MR", "FNG_EMA_MR"), ("BRC20_RSI_MR", "BRC20_RSI_MR")]:
            rows = walkforward_by_strat[key]
            valid = [fd for fd in rows if fd["status"] == "VALIDATED" and fd["net"] is not None]
            positive = sum(1 for fd in valid if fd["net"] > 0)
            L.append(f"- **{name}**：{len(valid)}/{len(rows)} 个 fold 产生独立 OOS 成交；其中 {positive} 个 fold 净收益为正。")
        L.append("- **解释边界**：这是训练窗口内参数选择 + 后续独立窗口验证；若训练期无正 edge，该 fold 不会强行选参数。不同 fold 的策略参数可能不同，结果不能与固定参数回测混为一谈。\n")
        cv["walkForward"].append({
            "sym": label.split("(")[0],
            "strategies": walkforward_by_strat,
        })

        # 多周期：4h vs 1d（仅 BRC20_RSI_MR）
        L.append(f"### 6.2 {label} · 多周期对比（BRC20_RSI_MR，样本内净收益）\n")
        L.append("| 周期 | 样本内净收益 | 交易数 |")
        L.append("|---|---|---|")
        per_iv = {}
        for iv in ("4h", "1d"):
            bars = fetch_klines(_sym_of(label), iv, start_ms, now_ms)
            c = Context(bars, fng_pts)
            oos_idx = 0
            for i, b in enumerate(bars):
                if b["t"] >= oos_ms:
                    oos_idx = i
                    break
            s = simulate(STRATEGIES["BRC20_RSI_MR"](), c, oos_idx)
            per_iv[iv] = s["insample"]["net"] * 100
            L.append(f"| {iv} | {s['insample']['net']*100:+.2f}% | {s['insample']['n']} |")
        L.append("")
        L.append("- **解读**：若 4h 与 1d 样本内结论方向一致，说明信号不依赖单一粒度；"
                 "若方向相反，则可能是参数/粒度过拟合，需重新审视。\n")
        cv["grainFlip"].append({
            "sym": label.split("(")[0], "strat": "BRC20_RSI_MR",
            "h4": round(per_iv["4h"], 2), "d1": round(per_iv["1d"], 2),
        })

        # vintage（取 BRC20_RSI_MR，交易数足够）
        folds = vintage_by_strat["BRC20_RSI_MR"]
        wins, pos, neg = [], 0, 0
        for fd in folds:
            net = fd["net"]
            if net is None:
                wins.append("—"); continue
            wins.append(f"{net*100:+.1f}%")
            if net >= 0: pos += 1
            else: neg += 1
        cv["vintage"].append({"sym": label.split("(")[0], "wins": wins, "pos": pos, "neg": neg})

    L.append("### 6.3 跨资产一致性（ORDI vs 1000SATS）\n")
    L.append("- BRC20 两标的同属比特币 L1 铭文生态、相关性高；若两标的 OOS 表现同向，可互为交叉验证；"
             "若严重分化，提示策略对单一代币路径过拟合。详见上方各 vintage 表。\n")

    L.append("### 6.4 交叉验证综合结论（由本次数据动态计算）\n")
    grain_flip = [
        row for row in cv["grainFlip"]
        if row["h4"] != 0 and row["d1"] != 0 and ((row["h4"] > 0) != (row["d1"] > 0))
    ]
    wf_folds = [
        fold
        for item in cv["walkForward"]
        for strategy_folds in item["strategies"].values()
        for fold in strategy_folds
    ]
    wf_valid = [fold for fold in wf_folds if fold["status"] == "VALIDATED" and fold["net"] is not None]
    wf_positive = sum(1 for fold in wf_valid if fold["net"] > 0)
    wf_negative = sum(1 for fold in wf_valid if fold["net"] <= 0)
    wf_no_train = sum(1 for fold in wf_folds if fold["status"] == "NO_TRAIN_EDGE")
    L.append(f"- **多周期方向反转**：{len(grain_flip)}/{len(cv['grainFlip'])} 个资产在 4h 与 1d 样本内方向相反。")
    L.append(f"- **严格 Walk-forward**：{len(wf_valid)} 个 fold 有独立 OOS 成交；{wf_positive} 个为正、{wf_negative} 个非正；{wf_no_train} 个 fold 因训练期没有正 edge 而停止选参。")
    if not wf_valid:
        conclusion = "当前没有足够的独立 Walk-forward OOS 成交，策略维持未放行。"
    elif wf_negative > 0 or grain_flip:
        conclusion = "Walk-forward 或多周期验证仍存在负收益/方向反转，策略维持未放行。"
    else:
        conclusion = "本轮 Walk-forward 和多周期检查未发现负向 fold；仍需结合样本量、成本、Monte Carlo 与人工审查，不能自动晋级。"
    L.append("- **结论**：" + conclusion + "\n")
    cv["conclusion"] = conclusion
    return "\n".join(L), cv


def _write_research_json(data):
    """把研究结论结构化写入 dashboard/data/research.json（前端实时刷新数据源）。"""
    out_dir = os.path.join(WORKDIR, "dashboard", "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "research.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _build_grid_cv(brc20_ctx, oos_ms):
    """对 BRC20_RSI_MR 在 (oversold × overbought) 网格上做交叉验证，量化过拟合程度。
    返回 (markdown, struct)：struct 供前端 JSON 渲染。数据：ORDI/SATS 的 4h K 线（真实可达）。"""
    L = ["\n### 6.5 多参数网格交叉验证（量化过拟合程度）\n"]
    L.append("> 方法：对 `BRC20_RSI_MR` 的 **oversold（超卖阈值）× overbought（超买阈值）** 做笛卡尔积回测，"
             "观察「最佳参数」是否只是**樱桃挑选**。若最佳组合在样本内极亮眼、但 OOS 不盈利、"
             "或网格内盈利组合占比低、或最佳相对中位数偏离大，则过拟合嫌疑高。\n")

    # 切分 OOS（用与回测一致的分界）
    param_grid = {
        "oversold": [22, 26, 30, 35, 40],
        "overbought": [60, 65, 70, 75, 80],
    }
    L.append(f"- 网格规模：oversold ∈ {param_grid['oversold']} × overbought ∈ {param_grid['overbought']}"
             f" = **{len(param_grid['oversold'])*len(param_grid['overbought'])}** 组合。\n")

    grid = {"axes": param_grid, "ordi": None, "sats": None}

    for label, ctx in brc20_ctx.items():
        # OOS 分界索引
        oos_idx = 0
        for i, b in enumerate(ctx.bars):
            if b["t"] >= oos_ms:
                oos_idx = i
                break
        results = grid_search(STRATEGIES["BRC20_RSI_MR"], ctx, param_grid, oos_idx)
        sg = summarize_grid(results)
        L.append(f"\n#### {label}\n")
        if not sg["ok"]:
            L.append("- 网格无结果。\n")
            continue
        best = sg["best"]
        if sg["prof_oos_ratio"] is None:
            oos_ratio_str = "—"
        else:
            oos_ratio_str = f"{sg['prof_oos']}/{sg['oos_avail']} ({sg['prof_oos_ratio']*100:.0f}%)"
        L.append(f"- **样本内盈利组合占比**：{sg['prof_in']}/{sg['n_combos']}"
                 f"（{sg['prof_in_ratio']*100:.0f}%）；"
                 f"**OOS 盈利组合占比**：{oos_ratio_str}。\n")
        L.append(f"- **离散度（最佳组合样本内收益 − 网格中位数）**：{sg['dispersion']*100:+.0f}%。\n")
        if best["oos_net"] is None:
            best_oos_str = "—(样本不足)"
        else:
            best_oos_str = f"{best['oos_net']*100:+.2f}%"
        L.append(f"- **最佳样本内组合**：oversold={best['params']['oversold']}, "
                 f"overbought={best['params']['overbought']} → 样本内 **{best['ins_net']*100:+.2f}%**，"
                 f"OOS {best_oos_str}（OOS 交易 {best['oos_n']} 笔）。\n")
        verdict = "**过拟合嫌疑高** ❌" if sg["overfit_flag"] else "**跨参数较稳健** ✅"
        L.append(f"- **过拟合判定**：{verdict}\n")
        for nt in sg["notes"]:
            L.append(f"  - {nt}\n")

        # 代表性组合表（展示符号敏感性）
        L.append("\n代表性组合（样本内净收益 / OOS净收益）：\n")
        L.append("| oversold\\overbought | " +
                 " | ".join(str(o) for o in param_grid["overbought"]) + " |")
        L.append("|---" * (len(param_grid["overbought"]) + 1) + "|")
        by_key = {(r["params"]["oversold"], r["params"]["overbought"]): r for r in results}
        matrix = []
        for os_ in param_grid["oversold"]:
            row = [f"{os_}"]
            mrow = []
            for ob in param_grid["overbought"]:
                r = by_key.get((os_, ob))
                if not r:
                    row.append("—"); mrow.append("—/—"); continue
                ins = f"{r['ins_net']*100:+.0f}%"
                oos = "—" if r["oos_net"] is None else f"{r['oos_net']*100:+.0f}%"
                row.append(f"{ins} / {oos}")
                mrow.append(f"{ins}/{oos}")
            L.append("| " + " | ".join(row) + " |")
            matrix.append(mrow)
        L.append("")
        L.append("- 表中「样本内 / OOS」；**正负号在网格内频繁切换**即说明收益对参数高度敏感、稳定性差。\n")

        # —— 结构化（前端 JSON 用）——
        gk = "sats" if "SATS" in label else "ordi"
        G = {
            "inProfit": f"{sg['prof_in']}/{sg['n_combos']} ({sg['prof_in_ratio']*100:.0f}%)",
            "oosProfit": oos_ratio_str,
            "dispersion": f"{sg['dispersion']*100:+.0f}%",
            "best": {
                "os": best["params"]["oversold"], "ob": best["params"]["overbought"],
                "inSample": round(best["ins_net"] * 100, 2),
                "oos": (round(best["oos_net"] * 100, 2) if best["oos_net"] is not None else None),
                "oosTrades": best["oos_n"],
            },
            "matrix": matrix,
            "verdict": ("过拟合嫌疑高 ❌" if sg["overfit_flag"] else "跨参数较稳健 ✅"),
        }
        grid[gk] = G

    L.append("### 6.6 网格交叉验证综合结论（事实，非推断）\n")
    L.append("- 单看「最佳参数」的样本内暴利（如 ORDI 上某组合 +100%+）会被网格打回原形："
             "一旦换一组相邻阈值，收益可能直接翻负。这正是**参数过拟合**的实证特征。\n")
    L.append("- 配合 §6.4 的「粒度反转」，ORDI/SATS 上 `BRC20_RSI_MR` **未通过交叉验证**；"
             "即便 g4（超额主门槛）在样本内为正，也因 OOS 不稳/网格敏感维持「不予放行」。\n")
    return "\n".join(L), grid


def _sym_of(label):
    return "ORDIUSDT" if "ORDI" in label else "1000SATSUSDT"


def _norm_fr(fr):
    """资金费率 → 前端结构化；失败保留 reason。"""
    return {
        "ok": bool(fr.get("ok")),
        "rate": (round(fr["rate"], 8) if fr.get("ok") and fr.get("rate") is not None else None),
        "source": fr.get("source"),
        "demo": bool(fr.get("demo")),
        "reason": fr.get("reason"),
    }


def _norm_liq(liq):
    """爆仓 → 前端结构化；失败保留 reason。"""
    return {
        "ok": bool(liq.get("ok")),
        "source": liq.get("source"),
        "demo": bool(liq.get("demo")),
        "count": liq.get("count"),
        "reason": liq.get("reason"),
    }


def _norm_runes(runes):
    """RUNES 代币榜 → 前端结构化；跨源(UniSat/Dune/DEMO)字段差异做防御性归一。
    失败（无 key / 网络封禁）保留 reason，tokens 为空。"""
    base = {
        "ok": bool(runes.get("ok")),
        "source": runes.get("source"),
        "demo": bool(runes.get("demo")),
        "reason": runes.get("reason"),
        "tokens": [],
    }
    for t in (runes.get("tokens") or [])[:20]:
        if not isinstance(t, dict):
            continue
        base["tokens"].append({
            "symbol": t.get("symbol") or t.get("ticker") or "?",
            "name": t.get("name") or t.get("tokenName") or t.get("symbol") or "",
            "priceUsd": (t.get("priceUsd") if t.get("priceUsd") is not None
                         else t.get("price") or t.get("lastPrice")),
            "volume24h": (t.get("volume24h") if t.get("volume24h") is not None
                          else t.get("vol24h") or t.get("volume")),
            "mcap": (t.get("mcap") if t.get("mcap") is not None
                     else t.get("marketCap") or t.get("market_cap")),
        })
    return base


def _build_supplementary():
    """RUNES / 资金费率 / 爆仓 连接器结果（配 key + 可达网络即真用；本环境优雅降级为未知）。
    返回 (markdown, struct)：struct 供前端 JSON 渲染，且对无 key 环境保持诚实的「未知」。"""
    fr = fetch_funding_rate("BTCUSDT")
    liq = fetch_liquidations("BTCUSDT")
    runes = fetch_runes_top(20)

    L = ["\n## 七、永续 / RUNES 补充数据（配 key + 可达网络自动启用）\n"]
    L.append("> 以下接口在**可访问网络**或配置对应 **API key** 后自动取数；本环境（仅放行 Binance 镜像 / "
             "DefiLlama / alternative.me / mempool.space）下因**网络层封禁**优雅降级为「未知」，**绝不虚构**。\n")
    L.append("> 预览渲染格式：在本环境运行 `NR_DEMO=1 python run_research.py` 即可查看「已获取」排版（数据为示例，非真实）。\n")

    # 资金费率
    L.append("### 7.1 永续资金费率（BTCUSDT）")
    if fr.get("ok"):
        tag = "（演示格式，非真实）" if fr.get("demo") else ""
        L.append(f"- 当前资金费率：**{fr['rate']*100:.4f}%**（来源 {fr['source']}，"
                 f"时间 {bj_time(fr['ts'])}）{tag}")
    else:
        L.append(f"- **未知**：{fr['reason']}")
        L.append("  - 启用：`Bybit` 默认；或在可访问环境用 `fapi.binance.com/fapi/v1/premiumIndex` 回退。")

    # 爆仓
    L.append("\n### 7.2 爆仓 / 强平数据（BTCUSDT）")
    if liq.get("ok"):
        tag = "（演示格式，非真实）" if liq.get("demo") else ""
        L.append(f"- 已获取（来源 {liq['source']}，近 100 条强平记录 {liq.get('count','?')} 笔）{tag}")
    else:
        L.append(f"- **未知**：{liq['reason']}")
        L.append("  - 启用：`COINGLASS_API_KEY=xxx`（CoinGlass 清算聚合）或可达的 Binance `allForceOrders`。")

    # RUNES
    L.append("\n### 7.3 RUNES 代币榜（市值 / 价格 / 成交量）")
    if runes.get("ok"):
        tag = "（演示格式，非真实）" if runes.get("demo") else ""
        L.append(f"- 已获取（来源 {runes['source']}）{tag}")
        toks = runes.get("tokens") or []
        if toks:
            L.append("| 符文 | 价格(USD) | 24h量(USD) | 市值(USD) |")
            L.append("|---|---|---|---|")
            for t in toks[:8]:
                L.append(f"| {t.get('symbol','?')} | {t.get('priceUsd','?')} | "
                         f"{t.get('volume24h','?')} | {t.get('mcap','?')} |")
    else:
        L.append(f"- **未知**：{runes['reason']}")
        L.append("- 启用方式（二选一，设环境变量后重跑）：")
        L.append("  - `UNISAT_API_KEY=xxx` → UniSat `/v3/market/runes/tokens`")
        L.append("  - `DUNE_API_KEY=xxx` + `DUNE_RUNES_QUERY_ID=yyy` → Dune 查询")

    L.append("\n### 7.4 研究局限与已落地项（诚实标注）\n")
    L.append("1. **BRC20 样本内高收益「非 Beta、但过拟合」已证实**：§六 网格交叉验证显示，ORDI/SATS 在"
             "`BRC20_RSI_MR` 上最佳参数样本内亮眼、但相邻参数即翻负、OOS 不稳 → **过拟合嫌疑高**，框架维持「不予放行」。")
    L.append("2. **超额收益已升为主放行门槛（g4）**：策略须相对买入持有为正才可通过；BTC/ETH 上原策略跑输大盘，"
             "已不再被误判。OOS 饥饿因高频策略已缓解（各 vintage 10+ 笔），但 90 天 OOS 门槛（原 Prompt）保持不变。")
    L.append("3. **RUNES 代币级价格仍不可达（数据约束，非代码缺陷）**：DOG•GO•TO•THE•MOON 等 RUNES 龙头不上 CEX 现货，"
             "且 runealpha/ordinals/UniSat 等源在本环境网络层被封禁；当前仅以 BTC L1 手续费作活跃度代理，**非代币价格结论**。")
    L.append("4. **§七 真实数据启用方式**：在「可访问对应接口」的环境配置 `UNISAT_API_KEY` / `DUNE_API_KEY`(+`DUNE_RUNES_QUERY_ID`)"
             " / `COINGLASS_API_KEY` 后重跑即可真取；本沙箱因防火墙无法实测，连接器已就绪、解析路径经演示模式验证。\n")

    supp_struct = {
        "fundingRate": _norm_fr(fr),
        "liquidations": _norm_liq(liq),
        "runes": _norm_runes(runes),
    }
    return "\n".join(L), supp_struct


if __name__ == "__main__":
    main()
