# -*- coding: utf-8 -*-
"""
示例策略（明确标注：示例 / 教学，非投资建议）
============================================
策略名：FNG-EMA 均值回归 v1
核心思想：
  恐贪指数在极端区（极度恐惧 ≤25 / 极度贪婪 ≥75）往往伴随情绪超调，
  配合「价格位于 200 周期 EMA 下方/上方」的趋势过滤与 RSI 超卖/超买，
  做均值回归。属于情绪反向 + 趋势确认的低频策略。

⚠️ 这不是投资建议，也不构成任何买卖指令。仅用于演示「三道关卡」研究框架。
任何人据此实盘，盈亏自负。
"""

from backtest_engine import Context  # noqa: F401  (ctx 类型提示用)


class FngEmaMeanReversion:
    """
    参数（共 3 个，未超过 Prompt 反过拟合阈值）：
      fng_extreme : 恐贪极端阈值（≤ 此值做多；≥ 100-此值 做空）
      rsi_entry   : RSI 入场阈值（超卖 < 此值做多；超买 > 100-此值 做空）
      max_hold    : 最大持仓根数（4h），约 3.3 天
    固定常量（非参数）：止损 3%；趋势过滤用 EMA200/EMA50。
    """

    def __init__(self, fng_extreme=25, rsi_entry=35, max_hold=20, **kwargs):
        self.fng_extreme = int(fng_extreme)
        self.rsi_entry = int(rsi_entry)
        self.max_hold = int(max_hold)
        self.stop_pct = 0.03  # 固定 3% 止损（常量，不计入可调参数）

        self.params = {
            "fng_extreme": self.fng_extreme,
            "rsi_entry": self.rsi_entry,
            "max_hold": self.max_hold,
        }

        # —— 第一关：说清楚（显式声明）——
        self.one_liner = ("恐贪极端 + 200EMA趋势过滤 + RSI超卖/超买 的均值回归 "
                          "（示例/教学，非投资建议）")
        self.entry_rule = (f"恐贪≤{self.fng_extreme} 且 价格<EMA200 且 RSI14<{self.rsi_entry} → 做多；"
                           f"恐贪≥{100 - self.fng_extreme} 且 价格>EMA200 且 RSI14>{100 - self.rsi_entry} → 做空")
        self.exit_rule = (f"价格触碰EMA50、或持仓达{self.max_hold}根4h(约3.3天)、"
                          "或恐贪回到45–55中性区 → 平仓")
        self.surrender_rule = (f"浮亏>{self.stop_pct:.0%} 立即止损认输；"
                               "若 OOS 净收益转负则弃用该策略")

        # —— 第二关：有道理（定性，交人工判断）——
        self.edge_rationale = ("极端恐贪常对应情绪超调与被动止损盘集中，"
                               "待价格回归趋势均线时博弈情绪修复；"
                               "EMA200 过滤掉无趋势的噪音区间，降低假信号。")
        self.counterparty = ("追涨杀跌的散户情绪盘、情绪化止损盘，"
                             "以及趋势跟踪策略在反转点的反向平仓盘。")

        # 内部状态
        self.position = "FLAT"
        self.entry_i = 0
        self.entry_price = 0.0

    def step(self, i, ctx):
        # 预热：EMA200 需要至少 200 根
        if i < 200:
            return "HOLD"
        c = ctx.closes[i]
        ema200 = ctx.ema200[i]
        ema50 = ctx.ema50[i]
        rsi = ctx.rsi14[i]
        fng = ctx.fng_at(i)

        # —— 持仓管理（出场 / 止损）——
        if self.position == "LONG":
            held = i - self.entry_i
            if c < self.entry_price * (1 - self.stop_pct):
                self.position = "FLAT"
                return "FLAT"
            if c > ema50 or held >= self.max_hold or (fng is not None and 45 <= fng <= 55):
                self.position = "FLAT"
                return "FLAT"
            return "HOLD"

        if self.position == "SHORT":
            held = i - self.entry_i
            if c > self.entry_price * (1 + self.stop_pct):
                self.position = "FLAT"
                return "FLAT"
            if c < ema50 or held >= self.max_hold or (fng is not None and 45 <= fng <= 55):
                self.position = "FLAT"
                return "FLAT"
            return "HOLD"

        # —— 空仓：寻找入场 ——
        if fng is None or rsi is None or ema200 is None or ema50 is None:
            return "HOLD"

        if fng <= self.fng_extreme and c < ema200 and rsi < self.rsi_entry:
            self.position = "LONG"
            self.entry_i = i
            self.entry_price = c
            return "LONG"

        if fng >= (100 - self.fng_extreme) and c > ema200 and rsi > (100 - self.rsi_entry):
            self.position = "SHORT"
            self.entry_i = i
            self.entry_price = c
            return "SHORT"

        return "HOLD"


# 策略注册表见文件末尾（需在所有策略类定义之后）


class Brc20RsiMeanReversion:
    """
    BRC20 原生高频均值回归（对称）。
    参数（2 个，未超反过拟合阈值）：
      oversold    : RSI14 超卖阈值（< 此值做多）
      overbought  : RSI14 超买阈值（> 此值做空）
    固定常量（非参数）：rsi_period=14（用 ctx.rsi14）；止损 5%；RSI 回中性(50)平仓。
    设计目的：相对 FNG_EMA_MR（依赖恐贪极端、触发低频），本策略仅靠价格动量(RSI)触发，
    在 4h 上信号频率显著更高，用于填满 90 天样本外窗口、压制单资产过拟合嫌疑。
    属「三道关卡」研究框架演示，非投资建议，实盘盈亏自负。
    """

    def __init__(self, oversold=30, overbought=70, **kwargs):
        self.oversold = int(oversold)
        self.overbought = int(overbought)
        self.stop_pct = 0.05  # 固定 5% 止损（常量，不计入可调参数）

        self.params = {
            "oversold": self.oversold,
            "overbought": self.overbought,
        }

        # —— 第一关：说清楚（显式声明）——
        self.one_liner = ("BRC20 原生 4h RSI 对称均值回归（超卖做多 / 超买卖空，中性平仓）"
                          "（示例/教学，非投资建议）")
        self.entry_rule = (f"RSI14 < {self.oversold} → 做多；RSI14 > {self.overbought} → 做空")
        self.exit_rule = (f"RSI14 回到中性（做多仓 ≥50 平 / 做空仓 ≤50 平），或浮亏>{self.stop_pct:.0%} 止损")
        self.surrender_rule = (f"浮亏>{self.stop_pct:.0%} 立即止损认输；若 OOS 净收益转负则弃用该策略")

        # —— 第二关：有道理（定性，交人工判断）——
        self.edge_rationale = ("BRC20 高波动使 RSI 极值后多出现均值回归；对称双向捕捉上下影线回归，"
                               "不依赖宏观情绪，信号频率更高，更适合样本外验证。")
        self.counterparty = "情绪化追涨杀跌盘、AMM 套利与做市商的流动性再平衡盘。"

        # 内部状态
        self.position = "FLAT"
        self.entry_i = 0
        self.entry_price = 0.0

    def step(self, i, ctx):
        # 预热：RSI14 需要至少 14 根
        if i < 14:
            return "HOLD"
        rsi = ctx.rsi14[i]
        if rsi is None:
            return "HOLD"
        c = ctx.closes[i]

        # —— 持仓管理 ——
        if self.position == "LONG":
            if c < self.entry_price * (1 - self.stop_pct):
                self.position = "FLAT"
                return "FLAT"
            if rsi >= 50:
                self.position = "FLAT"
                return "FLAT"
            return "HOLD"
        if self.position == "SHORT":
            if c > self.entry_price * (1 + self.stop_pct):
                self.position = "FLAT"
                return "FLAT"
            if rsi <= 50:
                self.position = "FLAT"
                return "FLAT"
            return "HOLD"

        # —— 空仓：寻找入场 ——
        if rsi < self.oversold:
            self.position = "LONG"
            self.entry_i = i
            self.entry_price = c
            return "LONG"
        if rsi > self.overbought:
            self.position = "SHORT"
            self.entry_i = i
            self.entry_price = c
            return "SHORT"
        return "HOLD"


# 策略注册表（所有策略类定义之后）
STRATEGIES = {
    "FNG_EMA_MR": FngEmaMeanReversion,
    "BRC20_RSI_MR": Brc20RsiMeanReversion,
}
