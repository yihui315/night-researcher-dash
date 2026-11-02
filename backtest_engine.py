# -*- coding: utf-8 -*-
"""
夜班交易研究员 · 回测与分析引擎 (纯标准库，零外部依赖)
=====================================================================
设计目标（对应 Prompt「Grok Bot · 夜班交易研究员指令」）：
  1. 只用公开可复查数据；每个数字标注来源，拿不到写「未知」。
  2. 三道关卡：说清楚 / 有道理 / 扛得住。
  3. 反过拟合：参数>3 或调参结果大变 → 标「可疑」；必须留最近 3 个月验证 (OOS)。
  4. 交易次数 < 30 → 标「样本太少」。
  5. 本引擎只做研究/回测，不写下单代码、不给买卖建议。

数据源（均可匿名、无需 API key 的公开接口）：
  - K 线 (4h / 1d)：data-api.binance.vision  (主站 api.binance.com 在本环境被墙)
  - 恐贪指数：alternative.me/fng
  - 稳定币总供应：DefiLlama
  - 永续资金费率：本环境不可达 → 标「未知」(绝不虚构)

成本口径（来自 Prompt）：手续费单边 0.1% + 滑点单边 0.05% = 单边 0.15%，双边 0.3%。
"""

import json
import re
import time
import bisect
import math
import random
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

# ---------------------------------------------------------------------------
# 1. 网络层（urllib，带超时与失败兜底）
# ---------------------------------------------------------------------------
_HTTP_TIMEOUT = 25


def http_get_json(url):
    """拉取 JSON；任何失败返回 None（上层标「未知」）。"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "night-researcher/1.0"})
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def http_get_text(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "night-researcher/1.0"})
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return resp.read().decode("utf-8")
    except Exception:
        return None


def bj_time(ms):
    """毫秒时间戳 → 北京时间字符串 (UTC+8)。"""
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone(timedelta(hours=8)))
    return dt.strftime("%Y-%m-%d %H:%M")


# ---------------------------------------------------------------------------
# 2. 数据抓取
# ---------------------------------------------------------------------------
def fetch_klines(symbol, interval, start_ms, end_ms):
    """
    Binance 公开 K 线，自动分页（每页最多 1000 根）。
    返回 list[dict]: {t, o, h, l, c, v}  (t 为开盘毫秒)
    失败返回 []。
    """
    out = []
    cursor = start_ms
    base = ("https://data-api.binance.vision/api/v3/klines"
            f"?symbol={symbol}&interval={interval}&limit=1000")
    guard = 0
    while cursor < end_ms and guard < 50:
        guard += 1
        url = f"{base}&startTime={cursor}"
        raw = http_get_json(url)
        if not raw:
            break
        for row in raw:
            out.append({
                "t": int(row[0]),
                "o": float(row[1]), "h": float(row[2]),
                "l": float(row[3]), "c": float(row[4]),
                "v": float(row[5]),
            })
        last_t = raw[-1][0]
        if len(raw) < 1000:
            break
        cursor = last_t + 1
    # 按时间升序、去重
    out.sort(key=lambda x: x["t"])
    seen = set()
    dedup = []
    for r in out:
        if r["t"] in seen:
            continue
        seen.add(r["t"])
        dedup.append(r)
    return dedup


def fetch_fng(limit=800):
    """
    恐贪指数（每日）。返回按时间升序的 (ts_ms, value) 列表；失败返回 []。
    """
    raw = http_get_json(f"https://api.alternative.me/fng/?limit={limit}")
    if not raw or "data" not in raw:
        return []
    pts = []
    for d in raw["data"]:
        pts.append((int(d["timestamp"]) * 1000, int(d["value"])))
    pts.sort()
    return pts


def fetch_stablecoin_supply():
    """
    DefiLlama 稳定币总供应（USD）。
    返回 dict: {current, prev_day, prev_week, ts}；失败返回 None。
    """
    raw = http_get_json("https://stablecoins.llama.fi/stablecoins?includePrices=true")
    if not raw or "peggedAssets" not in raw:
        return None
    cur = prev_d = prev_w = 0.0
    for a in raw["peggedAssets"]:
        circ = a.get("circulating", {})
        cur += float(circ.get("peggedUSD", 0) or 0)
        # 注意：circulatingPrevDay / PrevWeek 是资产级同级字段，不在 circulating 内
        prev_d += float((a.get("circulatingPrevDay") or {}).get("peggedUSD", 0) or 0)
        prev_w += float((a.get("circulatingPrevWeek") or {}).get("peggedUSD", 0) or 0)
    ts = int(time.time() * 1000)
    return {"current": cur, "prev_day": prev_d, "prev_week": prev_w, "ts": ts}


# ---------------------------------------------------------------------------
# 3. 指标（纯 Python）
# ---------------------------------------------------------------------------
def ema(values, period):
    """返回与 values 等长的 EMA 列表；前 period-1 个为 None。"""
    if period <= 0 or len(values) < period:
        return [None] * len(values)
    k = 2.0 / (period + 1)
    out = [None] * len(values)
    # 种子用 SMA
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(values, period=14):
    """Wilder RSI。返回等长列表，前 period 个为 None。"""
    out = [None] * len(values)
    if len(values) < period + 1:
        return out
    gains = 0.0
    losses = 0.0
    for i in range(1, period + 1):
        ch = values[i] - values[i - 1]
        if ch >= 0:
            gains += ch
        else:
            losses -= ch
    avg_g = gains / period
    avg_l = losses / period
    out[period] = 100.0 if avg_l == 0 else 100.0 - 100.0 / (1 + avg_g / avg_l)
    for i in range(period + 1, len(values)):
        ch = values[i] - values[i - 1]
        g = ch if ch >= 0 else 0.0
        l = -ch if ch < 0 else 0.0
        avg_g = (avg_g * (period - 1) + g) / period
        avg_l = (avg_l * (period - 1) + l) / period
        out[i] = 100.0 if avg_l == 0 else 100.0 - 100.0 / (1 + avg_g / avg_l)
    return out


def atr(highs, lows, closes, period=14):
    """Wilder ATR。"""
    out = [None] * len(closes)
    if len(closes) < period + 1:
        return out
    trs = []
    for i in range(1, len(closes)):
        tr = max(highs[i] - lows[i],
                 abs(highs[i] - closes[i - 1]),
                 abs(lows[i] - closes[i - 1]))
        trs.append(tr)
    prev = sum(trs[:period]) / period
    out[period] = prev
    for i in range(period + 1, len(closes)):
        tr = max(highs[i] - lows[i],
                 abs(highs[i] - closes[i - 1]),
                 abs(lows[i] - closes[i - 1]))
        prev = (prev * (period - 1) + tr) / period
        out[i] = prev
    return out


# ---------------------------------------------------------------------------
# 4. 上下文构建（避免前视）
# ---------------------------------------------------------------------------
class Context:
    """为每根 4h K 线预计算指标 + 当日恐贪。strategy 只能读取 idx<=i 的数据。"""

    def __init__(self, bars_4h, fng_pts):
        self.bars = bars_4h
        self.closes = [b["c"] for b in bars_4h]
        self.highs = [b["h"] for b in bars_4h]
        self.lows = [b["l"] for b in bars_4h]
        self.times = [b["t"] for b in bars_4h]
        self.ema200 = ema(self.closes, 200)
        self.ema50 = ema(self.closes, 50)
        self.rsi14 = rsi(self.closes, 14)
        self.atr14 = atr(self.highs, self.lows, self.closes, 14)
        self.fng_pts = fng_pts  # 升序 (ts_ms, value)
        self._fng_ts = [p[0] for p in fng_pts]
        self._fng_val = [p[1] for p in fng_pts]

    def fng_at(self, idx):
        """bar idx 当日（及之前最近）的恐贪值；无数据返回 None。"""
        if not self.fng_pts:
            return None
        t = self.times[idx]
        pos = bisect.bisect_right(self._fng_ts, t) - 1
        if pos < 0:
            return None
        return self._fng_val[pos]

    def regime_at(self, idx, lookback=120):
        """
        以入场前 lookback 根 4h K 线收益划分市场状态：
        > +10% 上涨段；< -10% 下跌段；否则横盘段。
        """
        if idx < lookback:
            start = 0
        else:
            start = idx - lookback
        if start >= idx:
            return "横盘"
        ret = self.closes[idx] / self.closes[start] - 1.0
        if ret > 0.10:
            return "上涨"
        if ret < -0.10:
            return "下跌"
        return "横盘"


# ---------------------------------------------------------------------------
# 5. 回测模拟（目标仓位法 + 策略状态机）
# ---------------------------------------------------------------------------
SIDE_COST = 0.0015  # 单边 0.15% (手续费0.1% + 滑点0.05%)


def simulate(strategy, ctx, oos_split_idx, start_idx=0, end_idx=None):
    """
    事件驱动回测：收盘产生信号，下一根 K 线开盘成交；止损使用当根 OHLC 检查。
    每次调用克隆策略实例，避免回测/敏感性分析之间发生状态污染。
    成本仍按单边 SIDE_COST 计入；该模型是 OHLC 级近似，不等同逐笔订单簿回放。
    """
    bars = ctx.bars
    n = len(bars)
    start_idx = max(0, min(n, int(start_idx or 0)))
    end_idx = n if end_idx is None else max(start_idx, min(n, int(end_idx)))
    params = dict(getattr(strategy, "params", {}) or {})
    runtime = strategy.__class__(**params)
    pos = 0
    entry_price = 0.0
    entry_i = 0
    trades = []
    equity_realized = 1.0
    equity_curve = []
    pending = None

    def close_position(price, idx, forced=False):
        nonlocal pos, entry_price, entry_i, equity_realized
        if pos == 0:
            return
        if pos > 0:
            ret = (price / entry_price - 1) - 2 * SIDE_COST
            direction = "LONG"
        else:
            ret = (entry_price / price - 1) - 2 * SIDE_COST
            direction = "SHORT"
        trades.append(_mk_trade(direction, entry_price, price, entry_i, idx, ret, ctx, forced))
        equity_realized = max(0.0, equity_realized * (1 + ret))
        pos = 0
        entry_price = 0.0
        entry_i = 0

    def open_position(direction, price, idx):
        nonlocal pos, entry_price, entry_i
        pos = 1 if direction == "LONG" else -1
        entry_price = price
        entry_i = idx
        runtime.position = direction
        runtime.entry_price = price
        runtime.entry_i = idx

    for i in range(start_idx, end_idx):
        bar = bars[i]
        # 前一根收盘产生的信号，在本根开盘执行。
        if pending == "FLAT":
            close_position(bar["o"], i)
            runtime.position = "FLAT"
        elif pending in ("LONG", "SHORT"):
            wanted = 1 if pending == "LONG" else -1
            if pos != wanted:
                if pos != 0:
                    close_position(bar["o"], i)
                open_position(pending, bar["o"], i)
        pending = None

        # 止损优先于收盘信号；跳空时按开盘价，盘中触发按止损价。
        stopped = False
        stop_pct = float(getattr(runtime, "stop_pct", 0) or 0)
        if pos == 1 and stop_pct > 0:
            stop_price = entry_price * (1 - stop_pct)
            if bar["o"] <= stop_price:
                close_position(bar["o"], i)
                stopped = True
            elif bar["l"] <= stop_price:
                close_position(stop_price, i)
                stopped = True
        elif pos == -1 and stop_pct > 0:
            stop_price = entry_price * (1 + stop_pct)
            if bar["o"] >= stop_price:
                close_position(bar["o"], i)
                stopped = True
            elif bar["h"] >= stop_price:
                close_position(stop_price, i)
                stopped = True
        if stopped:
            runtime.position = "FLAT"

        # 每根 K 线收盘盯市，未平仓仓位计入浮动回撤。
        if pos == 0:
            equity_curve.append(equity_realized)
        else:
            mark = bar["c"]
            gross = (mark / entry_price - 1) if pos > 0 else (entry_price / mark - 1)
            equity_curve.append(max(0.0, equity_realized * (1 + gross - SIDE_COST)))

        # 使用当前 K 线收盘可见的信息产生下一根 K 线的待执行信号。
        if not stopped:
            action = runtime.step(i, ctx)
            if action in ("LONG", "SHORT", "FLAT"):
                pending = action

    # 最后一根 K 线没有下一根开盘价；未平仓头寸按最后收盘价强制估值退出。
    if pos != 0 and end_idx > start_idx:
        close_position(bars[end_idx - 1]["c"], end_idx - 1, True)
        equity_curve[-1] = equity_realized
    if not equity_curve:
        equity_curve = [1.0]

    result = _summarize(trades, equity_curve, oos_split_idx, bars)
    result["execution_model"] = "next_bar_open_with_intrabar_ohlc_stops"
    return result


def buy_and_hold_return(bars):
    """同窗口买入持有收益（首根收盘→末根收盘），用于分离 Beta 与择时 skill。"""
    if len(bars) < 2:
        return None
    return bars[-1]["c"] / bars[0]["c"] - 1.0


def _first_idx_ge(times, ms):
    """返回 times 中第一个 >= ms 的索引（times 升序）；无则返回 None。"""
    import bisect
    idx = bisect.bisect_left(times, ms)
    return idx if idx < len(times) else None


def _fold_stats(trades):
    if not trades:
        return {"n": 0, "net": None, "win_rate": None}
    net = 1.0
    wins = 0
    for t in trades:
        net *= (1 + t["ret"])
        if t["ret"] > 0:
            wins += 1
    net -= 1.0
    return {"n": len(trades), "net": net, "win_rate": wins / len(trades)}


def walk_forward_oos(strategy_cls, ctx, param_grid, folds=3, oos_days=90, min_train_trades=10):
    """
    严格滚动 Walk-forward：
    1. 每个 fold 的训练集只包含验证窗口开始之前的数据；
    2. 只在训练集上跑参数网格并选择训练表现最好的组合；
    3. 用新策略实例，在后续 90 天验证窗口从空仓开始运行；
    4. 验证上下文在 fold 结束处截断，禁止读取未来数据。

    返回每个 fold 的训练样本、所选参数、独立 OOS 交易和验证指标。
    """
    dayms = 86400_000
    if not ctx.times:
        return []
    now = ctx.times[-1] + 1
    results = []

    for fold in range(folds):
        start_ms = now - (fold + 1) * oos_days * dayms
        end_ms = now - fold * oos_days * dayms
        idx_s = _first_idx_ge(ctx.times, start_ms)
        idx_e = _first_idx_ge(ctx.times, end_ms)
        if idx_e is None:
            idx_e = len(ctx.bars)
        if idx_s is None or idx_s < 250 or idx_e <= idx_s:
            continue

        # 训练数据严格截断在验证窗口开始之前。
        train_bars = ctx.bars[:idx_s]
        train_end_ms = train_bars[-1]["t"] if train_bars else 0
        train_fng = [point for point in ctx.fng_pts if point[0] <= train_end_ms]
        train_ctx = Context(train_bars, train_fng)
        train_results = grid_search(
            strategy_cls,
            train_ctx,
            param_grid,
            len(train_ctx.bars) + 1
        )
        eligible = [
            item for item in train_results
            if item["ins_n"] >= min_train_trades and item["ins_net"] > 0
        ]
        if not eligible:
            results.append({
                "fold": fold,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "train_n": max((item["ins_n"] for item in train_results), default=0),
                "train_net": None,
                "selected_params": None,
                "n": 0,
                "net": None,
                "win_rate": None,
                "max_drawdown": None,
                "status": "NO_TRAIN_EDGE",
            })
            continue

        # 选择只依赖训练窗口；验证数据没有参与参数选择。
        best = max(eligible, key=lambda item: item["ins_net"])
        validation_bars = ctx.bars[:idx_e]
        validation_end_ms = validation_bars[-1]["t"] if validation_bars else 0
        validation_fng = [point for point in ctx.fng_pts if point[0] <= validation_end_ms]
        validation_ctx = Context(validation_bars, validation_fng)

        validation = simulate(
            strategy_cls(**best["params"]),
            validation_ctx,
            idx_s,
            start_idx=idx_s,
            end_idx=idx_e,
        )
        fold_trades = [
            trade for trade in validation["trades"]
            if idx_s <= trade["entry_i"] < idx_e and idx_s <= trade["exit_i"] < idx_e
        ]
        stats = _fold_stats(fold_trades)
        results.append({
            "fold": fold,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "train_n": best["ins_n"],
            "train_net": best["ins_net"],
            "selected_params": best["params"],
            "n": stats["n"],
            "net": stats["net"],
            "win_rate": stats["win_rate"],
            "max_drawdown": validation["max_drawdown"],
            "status": "VALIDATED" if stats["n"] else "NO_OOS_TRADES",
        })

    return results


# ---------------------------------------------------------------------------
# 4b. 多参数网格交叉验证（量化过拟合程度）
# ---------------------------------------------------------------------------
def grid_search(strategy_cls, ctx, param_grid, oos_split_idx):
    """
    对给定策略类在 param_grid（{参数名: [取值...]}）上做笛卡尔积回测。
    返回每组合的 样本内净收益 / OOS净收益 / 交易数。
    用于量化『最佳参数是否樱桃挑选』（见 设计文档 §10.2）。

    前视安全性：同 rolling_oos —— 引擎指标在 idx 处仅用 <=idx 数据，
    故网格内每个组合各自重算 simulate 不引入前视偏差。
    """
    from itertools import product
    keys = list(param_grid.keys())
    out = []
    for combo in product(*param_grid.values()):
        params = dict(zip(keys, combo))
        strat = strategy_cls(**params)
        s = simulate(strat, ctx, oos_split_idx)
        ins = s["insample"]
        oos = s["oos"]
        out.append({
            "params": params,
            "ins_net": ins["net"] if ins["n"] else 0.0,
            "ins_n": ins["n"],
            "oos_net": oos["net"] if oos["n"] else None,
            "oos_n": oos["n"],
        })
    return out


def summarize_grid(results):
    """把网格结果压缩成过拟合量化指标。事实，非推断。"""
    if not results:
        return {"ok": False, "notes": ["网格无结果"]}
    ins_nets = [r["ins_net"] for r in results]
    best = max(results, key=lambda r: r["ins_net"])
    median_ins = sorted(ins_nets)[len(ins_nets) // 2]
    prof_in = sum(1 for x in ins_nets if x > 0)
    oos_avail = [r for r in results if r["oos_net"] is not None]
    prof_oos = sum(1 for r in oos_avail if r["oos_net"] > 0)

    # 离散度：最佳组合样本内收益相对网格中位数的偏离（>0.5 视为敏感/樱桃挑选嫌疑）
    if best["ins_net"] != 0:
        dispersion = (best["ins_net"] - median_ins) / abs(best["ins_net"])
    else:
        dispersion = 0.0

    overfit_flag = False
    notes = []
    if best["ins_net"] > 0 and (best["oos_net"] is None or best["oos_net"] <= 0):
        overfit_flag = True
        notes.append("最佳样本内组合在 OOS 未盈利（或样本不足）→ 疑似曲线拟合")
    if dispersion > 0.5:
        overfit_flag = True
        notes.append(f"最佳组合样本内收益较网格中位数高出 {dispersion*100:.0f}% → 参数敏感/樱桃挑选嫌疑")
    if oos_avail and prof_oos / len(oos_avail) < 0.5:
        overfit_flag = True
        notes.append(f"仅 {prof_oos}/{len(oos_avail)} 个有 OOS 的组合盈利 → 跨参数稳健性差")
    if not notes:
        notes.append("网格内最佳组合 OOS 盈利、离散度与跨参数稳健性均在阈值内")

    return {
        "ok": True,
        "n_combos": len(results),
        "best": best,
        "median_ins": median_ins,
        "prof_in": prof_in,
        "prof_in_ratio": prof_in / len(results),
        "oos_avail": len(oos_avail),
        "prof_oos": prof_oos,
        "prof_oos_ratio": (prof_oos / len(oos_avail)) if oos_avail else None,
        "dispersion": dispersion,
        "overfit_flag": overfit_flag,
        "notes": notes,
    }


def _mk_trade(direction, ep, xp, ei, xi, ret, ctx, forced):
    return {
        "direction": direction,
        "entry_price": ep,
        "exit_price": xp,
        "entry_i": ei,
        "exit_i": xi,
        "ret": ret,
        "gross_ret": ret + 2 * SIDE_COST,
        "round_trip_cost": 2 * SIDE_COST,
        "forced": forced,
        "regime": ctx.regime_at(ei),
        "oos": xi >= 0 and False,  # 占位，下面统一标
    }


def _wilson_interval(wins, n, z=1.96):
    if n <= 0:
        return None
    p = wins / n
    z2 = z * z
    den = 1 + z2 / n
    centre = p + z2 / (2 * n)
    margin = z * math.sqrt((p * (1 - p) / n) + z2 / (4 * n * n))
    return {"lower": max(0.0, (centre - margin) / den),
            "upper": min(1.0, (centre + margin) / den),
            "confidence": 0.95, "method": "Wilson score interval"}


def _percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    index = int(round((len(ordered) - 1) * p))
    return ordered[max(0, min(len(ordered) - 1, index))]


def _monte_carlo(trades, simulations=1000, seed=20261102):
    """按净交易收益 bootstrap 重采样；不是逐笔盘口/价格路径模拟。"""
    returns = [float(t.get("ret", 0.0)) for t in trades]
    if not returns:
        return {"simulations": 0, "method": "trade-return bootstrap", "status": "NO_TRADES"}
    rng = random.Random(seed)
    terminal_returns = []
    max_drawdowns = []
    n = len(returns)
    for _ in range(simulations):
        equity = 1.0
        peak = 1.0
        mdd = 0.0
        for _ in range(n):
            r = rng.choice(returns)
            equity *= max(0.0, 1.0 + r)
            peak = max(peak, equity)
            if peak > 0:
                mdd = max(mdd, (peak - equity) / peak)
        terminal_returns.append(equity - 1.0)
        max_drawdowns.append(mdd)
    return {
        "simulations": simulations,
        "method": "bootstrap with replacement on net trade returns",
        "status": "ESTIMATE",
        "terminal_return_p05": _percentile(terminal_returns, 0.05),
        "terminal_return_p50": _percentile(terminal_returns, 0.50),
        "terminal_return_p95": _percentile(terminal_returns, 0.95),
        "probability_of_loss": sum(1 for value in terminal_returns if value < 0) / simulations,
        "max_drawdown_p95": _percentile(max_drawdowns, 0.95),
        "limitation": "does not model serial correlation, changing liquidity, or intratrade price paths",
    }


def _slippage_sensitivity(trades, extra_bps=(0, 5, 10, 20, 50)):
    """在原有单边成本之外，额外增加每边滑点，观察净收益退化。"""
    if not trades:
        return []
    out = []
    for bps in extra_bps:
        equity = 1.0
        extra_round_trip = 2 * (bps / 10000.0)
        for trade in trades:
            gross = float(trade.get("gross_ret", trade.get("ret", 0.0) + 2 * SIDE_COST))
            net = gross - 2 * SIDE_COST - extra_round_trip
            equity *= max(0.0, 1.0 + net)
        out.append({"extra_slippage_bps_per_side": bps, "net_return": equity - 1.0})
    return out


def _summarize(trades, equity, oos_split_idx, bars):
    for t in trades:
        t["oos"] = t["exit_i"] >= oos_split_idx

    bh = buy_and_hold_return(bars)
    full_net = equity[-1] - 1.0
    excess = (full_net - bh) if bh is not None else None
    insample = [t for t in trades if not t["oos"]]
    oos = [t for t in trades if t["oos"]]

    def stats(sub):
        if not sub:
            return {
                "n": 0, "win": 0, "win_rate": None, "win_rate_ci95": None,
                "avg_win": None, "avg_loss": None, "profit_factor": None,
                "profit_factor_unbounded": False, "expectancy": None,
                "payoff_ratio": None, "sharpe_per_trade": None,
                "sortino_per_trade": None, "net": None, "regime": {},
            }
        wins = [t["ret"] for t in sub if t["ret"] > 0]
        losses = [t["ret"] for t in sub if t["ret"] <= 0]
        n = len(sub)
        win_rate = len(wins) / n
        avg_win = sum(wins) / len(wins) if wins else 0.0
        avg_loss = sum(losses) / len(losses) if losses else 0.0
        sum_w = sum(wins)
        sum_l = -sum(losses)
        pf_unbounded = sum_l <= 0 and sum_w > 0
        pf = (sum_w / sum_l) if sum_l > 0 else (None if pf_unbounded else 0.0)
        net = 1.0
        for t in sub:
            net *= max(0.0, 1 + t["ret"])
        net -= 1.0
        rets = [float(t["ret"]) for t in sub]
        mean_ret = sum(rets) / n
        variance = sum((value - mean_ret) ** 2 for value in rets) / (n - 1) if n > 1 else 0.0
        std = math.sqrt(variance)
        downside_dev = math.sqrt(sum(min(0.0, value) ** 2 for value in rets) / n)
        sharpe = mean_ret / std if std > 0 else None
        sortino = mean_ret / downside_dev if downside_dev > 0 else None
        reg = {}
        for t in sub:
            reg.setdefault(t["regime"], {"n": 0, "net": 1.0})
            reg[t["regime"]]["n"] += 1
            reg[t["regime"]]["net"] *= max(0.0, 1 + t["ret"])
        for key in reg:
            reg[key]["net"] -= 1.0
        return {
            "n": n, "win": len(wins), "win_rate": win_rate,
            "win_rate_ci95": _wilson_interval(len(wins), n),
            "avg_win": avg_win, "avg_loss": avg_loss,
            "profit_factor": pf, "profit_factor_unbounded": pf_unbounded,
            "expectancy": mean_ret,
            "payoff_ratio": (avg_win / abs(avg_loss) if avg_loss < 0 else None),
            "sharpe_per_trade": sharpe, "sortino_per_trade": sortino,
            "risk_metric_basis": "per-trade returns; not annualized",
            "net": net, "regime": reg,
        }

    peak = equity[0]
    mdd = 0.0
    for value in equity:
        peak = max(peak, value)
        dd = (peak - value) / peak if peak > 0 else 0.0
        mdd = max(mdd, dd)

    return {
        "n_trades": len(trades),
        "max_drawdown": mdd,
        "equity_final": equity[-1],
        "buy_hold": bh,
        "full_net": full_net,
        "excess": excess,
        "insample": stats(insample),
        "oos": stats(oos),
        "monte_carlo": {"full": _monte_carlo(trades), "oos": _monte_carlo(oos)},
        "slippage_sensitivity": _slippage_sensitivity(trades),
        "trades": trades,
    }

# ---------------------------------------------------------------------------
# 6. 三道关卡 + 反过拟合
# ---------------------------------------------------------------------------
def evaluate_gates(strategy, summary, ctx):
    """返回关卡结果与反过拟合标记。事实与推断分离。"""
    n = summary["n_trades"]
    gates = {}

    # 第一关：说清楚（结构性，策略必须显式声明 进场/离场/认输）
    gates["g1_clear"] = all([
        getattr(strategy, "entry_rule", ""),
        getattr(strategy, "exit_rule", ""),
        getattr(strategy, "surrender_rule", ""),
    ])

    # 第二关：有道理（定性，引擎无法自动验证 → 交人工，标注「需人工判断」）
    gates["g2_sensible"] = "需人工判断"

    # 第三关：扛得住（定量）
    g3 = {}
    g3["n_trades"] = n
    if n < 30:
        g3["pass"] = False
        g3["reason"] = "样本太少（交易次数<30）"
    else:
        ins = summary["insample"]
        oos_s = summary["oos"]
        g3["pass"] = True
        g3["insample_net"] = ins["net"]
        g3["oos_net"] = oos_s["net"] if oos_s["n"] else None
        # 失效判定：OOS 净收益显著恶化
        if oos_s["n"] and oos_s["net"] is not None and oos_s["net"] < ins["net"] * 0.3:
            g3["degrade"] = "OOS 表现较样本内明显恶化"
    gates["g3_robust"] = g3

    # 第四关（主放行指标）：相对买入持有超额（g4_excess）
    # 设计意图：策略若跑不赢「无脑持有」，则其「择时 skill」不成立，不应放行。
    # 这是压制「Beta 伪装成 Alpha」的核心闸门（见 设计文档 §10）。
    ex = summary.get("excess")
    g4 = {"excess": ex}
    if ex is None:
        g4["pass"] = "需人工判断（无买入持有基准）"
    elif ex >= 0:
        g4["pass"] = True
        g4["reason"] = f"相对买入持有 +{ex:.2%}，跑赢大盘，择时有效"
    else:
        g4["pass"] = False
        g4["reason"] = f"相对买入持有 {ex:.2%}（为负），跑输大盘，不予放行"
    gates["g4_excess"] = g4

    # 反过拟合
    overfit = {"param_count": len(getattr(strategy, "params", {})),
               "suspect": False, "notes": []}
    if overfit["param_count"] > 3:
        overfit["suspect"] = True
        overfit["notes"].append("参数个数>3，标「可疑」")
    # 调参敏感性：对关键参数 ±扰动，看净收益是否大变
    sens = _sensitivity(strategy, ctx)
    overfit["sensitivity"] = sens
    if sens["suspect"]:
        overfit["suspect"] = True
        overfit["notes"].append(sens["note"])

    return gates, overfit


def _sensitivity(strategy, ctx):
    """对策略关键参数做 ±扰动；每次都使用全新实例，避免状态复用。"""
    base_cls = strategy.__class__
    base_params = dict(getattr(strategy, "params", {}) or {})
    numeric = {k: v for k, v in base_params.items() if isinstance(v, (int, float))}
    if not numeric:
        return {"suspect": False, "note": "无可调数字参数", "swings": {}}

    base_sum = simulate(base_cls(**base_params), ctx, len(ctx.bars))
    base_net = base_sum["insample"]["net"] if base_sum["insample"]["n"] else base_sum["n_trades"]
    swings = {}
    suspect = False
    for k, v in numeric.items():
        if v == 0:
            continue
        for delta in (-0.15, 0.15):
            nv = v * (1 + delta)
            if isinstance(v, int):
                nv = int(round(nv))
                if nv == v:
                    nv = v + (1 if delta > 0 else -1)
            try:
                variant = base_cls(**{**base_params, k: nv})
            except Exception:
                continue
            result = simulate(variant, ctx, len(ctx.bars))
            vnet = result["insample"]["net"] if result["insample"]["n"] else 0.0
            swings[f"{k}:{v}->{nv}"] = round(vnet, 4)
            if base_net not in (0, None):
                rel = abs(vnet - base_net) / abs(base_net)
                if rel > 0.5 or (base_net > 0) != (vnet > 0):
                    suspect = True
    note = "调参后净收益变化>50%或变号，标「可疑」" if suspect else "调参敏感性在可接受范围"
    return {"suspect": suspect, "note": note, "swings": swings}


# ---------------------------------------------------------------------------
# 7. 卡片 / 早报格式化
# ---------------------------------------------------------------------------
def build_card(strategy, summary, gates, overfit, sources, symbol, excess=None):
    n = summary["n_trades"]
    g3 = gates["g3_robust"]
    g4 = gates["g4_excess"]
    ins_net = g3.get("insample_net")
    oos_net = g3.get("oos_net")
    oos_n = summary["oos"]["n"]
    # 优先用引擎内联计算的超额（summary["excess"]），回退到外部传入值
    ex = summary.get("excess")
    if ex is None:
        ex = excess

    # 死亡/存活判定（门优先级：样本量 > 超额主门槛 > 样本内盈亏 > 反过拟合 > 第三关 > OOS）
    if n < 30:
        death = f"样本太少（{n} 笔 < 30），无法判定存活"
    elif ex is not None and ex < 0:
        death = f"相对买入持有为负（{ex:.2%}），跑输大盘，不予放行（主门槛 g4 未过）"
    elif ins_net is not None and ins_net < 0:
        death = f"样本内净收益为负（{ins_net:.2%}），策略本身不赚钱"
    elif overfit["suspect"]:
        death = "反过拟合标记「可疑」，不予放行"
    elif not g3.get("pass"):
        death = g3.get("reason", "第三关未过")
    elif oos_net is None or oos_n < 10:
        death = f"样本外仅 {oos_n} 笔，不足以验证，不予放行"
    elif oos_net < 0:
        death = f"OOS 净收益为负（{oos_net:.2%}），样本内结论不可靠"
    else:
        death = "活下来"

    survived = (gates["g1_clear"] and n >= 30 and (not overfit["suspect"]) and
                ins_net is not None and ins_net > 0 and
                (ex is None or ex >= 0) and
                g4.get("pass") is True and
                oos_net is not None and oos_n >= 10 and oos_net >= 0)

    max_risk = (f"最大回撤 {summary['max_drawdown']:.2%}；"
                f"样本内净收益 {g3.get('insample_net',0):.2%}（{summary['insample']['n']}笔），"
                f"OOS 净收益 {_fmt_pct(g3.get('oos_net'))}（{oos_n}笔），"
                f"相对买入持有 {_fmt_pct(ex)}")

    failure = ("若恐贪指数失效（不再极端回归），或趋势过滤在剧烈单边中连续反向，"
               "策略会频繁止损。" if not survived else
               "失效情形同上；当前仅代表历史回测，未来未必重复。")

    passed = []
    passed.append("第一关(说清楚)" if gates["g1_clear"] else "✗第一关")
    passed.append("第四关(超额主门槛)" if g4.get("pass") is True else
                  ("第四关(超额为负)" if g4.get("pass") is False else "第四关(超额需人工)"))
    passed.append("第三关(扛得住)" if g3.get("pass") else "✗第三关")
    passed.append("反过拟合" if not overfit["suspect"] else "✗反过拟合可疑")
    passed_str = " / ".join(passed) + "；第二关(有道理)需人工判断"

    return {
        "symbol": symbol,
        "idea": getattr(strategy, "one_liner", ""),
        "passed": passed_str,
        "death_or_alive": death,
        "max_risk": max_risk,
        "failure": failure,
        "sources": sources,
        "excess": excess,
        "survived": survived,
    }


def format_card(card):
    lines = []
    lines.append(f"### 📌 {card['symbol']} · {card['idea']}")
    lines.append(f"- **过了几关**：{card['passed']}")
    lines.append(f"- **死因 / 活下来理由**：{card['death_or_alive']}")
    lines.append(f"- **最大风险**：{card['max_risk']}")
    if card.get("excess") is not None:
        ex = card["excess"]
        lines.append(f"- **相对买入持有（超额收益）**：{ex*100:+.2f}%（策略样本内 − 同窗口买入持有；正数=跑赢 Beta）")
    lines.append(f"- **失效情况**：{card['failure']}")
    lines.append(f"- **数据来源**：{card['sources']}")
    lines.append("")
    return "\n".join(lines)


def _fmt_pct(x):
    if x is None:
        return "未知(样本不足)"
    return f"{x:.2%}"


def build_morning_report(cards, fng_now, fng_prev, stable, sources_note, gen_time):
    """生成 2 分钟可读早报。"""
    L = []
    L.append("# 🌙 夜班交易研究员 · 早报")
    L.append(f"> 生成时间（北京时间）：{gen_time}  |  标的：BTC/ETH  |  周期：4h / 1d")
    L.append("")
    L.append("## 一、总表（活下来最多 2 个）")
    L.append("")
    L.append("| 标的 | 想法 | 过关 | 结论 | 样本内净收益 | 相对买入持有 | OOS净收益 | 最大回撤 |")
    L.append("|---|---|---|---|---|---|---|---|")
    alive = [c for c in cards if c["survived"]]
    # 只保留最多 2 个存活
    alive = alive[:2]
    for c in cards:
        tag = "✅存活" if c in alive else "❌未过"
        ins = _extract_ins(c)
        oos = _extract_oos(c)
        L.append(f"| {c['symbol']} | {c['idea']} | {c['passed']} | {tag} | {ins} | {_extract_excess(c)} | {oos} | {_extract_mdd(c)} |")
    L.append("")
    L.append("## 二、卡片")
    L.append("")
    for c in cards:
        L.append(format_card(c))
    L.append("## 三、今日对照（今天 vs 昨天变化最大的一件事）")
    L.append("")
    if fng_now is not None and fng_prev is not None:
        delta = fng_now - fng_prev
        L.append(f"- **恐贪指数**：{fng_prev} → {fng_now}（{('+' if delta>=0 else '')}{delta}）")
    else:
        L.append("- **恐贪指数**：未知")
    if stable:
        d = stable["current"] - stable["prev_day"]
        pct = d / stable["prev_day"] if stable["prev_day"] else 0
        L.append(f"- **稳定币总供应**：${stable['current']/1e9:.1f}B（较昨日 {('+' if d>=0 else '')}{d/1e9:.1f}B, {pct:+.2%}）")
    else:
        L.append("- **稳定币总供应**：未知")
    L.append("- **永续资金费率**：未知（本环境接口不可达，未虚构）")
    L.append("- **大额爆仓 / 已排期大事件**：未接入（需人工补充）")
    L.append("")
    L.append("## 四、最不该做的事")
    L.append("")
    L.append("1. **不要把回测当保证**——历史样本内/OOS 通过 ≠ 未来赚钱，本早报只做研究，不下单、不给买卖建议。")
    L.append("2. **样本<30 的策略一律不放大仓位**——本框架已对样本不足的策略强制标「未过」。")
    L.append("3. **反过拟合标记「可疑」的策略不要碰**——参数过多或调参结果大变的，极可能是曲线拟合。")
    L.append("4. **不要因恐贪极端就无脑反向**——需配合趋势过滤与止损，且需人工复核「有道理」这一关。")
    L.append("")
    L.append("---")
    L.append(f"数据源：{sources_note}")
    L.append("免责声明：本产出为量化研究方法论演示，所有策略均标注「示例/教学，非投资建议」。")
    return "\n".join(L)


def _extract_ins(card):
    # 从 max_risk 文本中粗略提取；更稳妥是从 summary，但这里从卡片复用
    import re
    m = re.search(r"样本内净收益 ([-\d.]+%)", card["max_risk"])
    return m.group(1) if m else "—"


def _extract_oos(card):
    m = re.search(r"OOS 净收益 ([-\d.]+%|未知\([^)]*\))", card["max_risk"])
    return m.group(1) if m else "—"


def _extract_mdd(card):
    m = re.search(r"最大回撤 ([-\d.]+%)", card["max_risk"])
    return m.group(1) if m else "—"


def _extract_excess(card):
    ex = card.get("excess")
    if ex is None:
        return "—"
    return f"{ex*100:+.2f}%"
