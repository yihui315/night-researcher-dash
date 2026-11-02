import unittest

from backtest_engine import Context, simulate, walk_forward_oos, _summarize


class FakeContext:
    def __init__(self, bars):
        self.bars = bars
        self.closes = [b["c"] for b in bars]
        self.times = [b["t"] for b in bars]

    def regime_at(self, idx):
        return "横盘"


class ScriptedStrategy:
    def __init__(self, **kwargs):
        self.params = {}
        self.stop_pct = 0.10
        self.position = "FLAT"
        self.entry_i = 0
        self.entry_price = 0.0

    def step(self, i, ctx):
        if i == 0:
            self.position = "LONG"
            self.entry_i = i
            self.entry_price = ctx.closes[i]
            return "LONG"
        if i == 1:
            self.position = "FLAT"
            return "FLAT"
        return "HOLD"


class BacktestExecutionTests(unittest.TestCase):
    def bars(self, rows):
        return [{"t": i * 60000, "o": o, "h": h, "l": l, "c": c, "v": 1} for i, (o, h, l, c) in enumerate(rows)]

    def test_signals_fill_on_next_bar_open_not_signal_close(self):
        ctx = FakeContext(self.bars([(99, 101, 98, 100), (110, 115, 105, 112), (120, 122, 118, 121)]))
        result = simulate(ScriptedStrategy(), ctx, 99)
        trade = result["trades"][0]
        self.assertEqual(trade["entry_price"], 110)
        self.assertEqual(trade["exit_price"], 120)
        self.assertAlmostEqual(trade["ret"], (120 / 110 - 1) - 0.003, places=8)

    def test_intrabar_stop_uses_low_and_fills_at_stop_price(self):
        ctx = FakeContext(self.bars([(99, 101, 98, 100), (100, 101, 80, 95), (95, 96, 94, 95)]))
        result = simulate(ScriptedStrategy(), ctx, 99)
        trade = result["trades"][0]
        self.assertEqual(trade["entry_price"], 100)
        self.assertEqual(trade["exit_price"], 90)
        self.assertAlmostEqual(trade["ret"], (90 / 100 - 1) - 0.003, places=8)

    def test_simulation_does_not_mutate_input_strategy_state(self):
        strategy = ScriptedStrategy()
        ctx = FakeContext(self.bars([(99, 101, 98, 100), (110, 115, 105, 112), (120, 122, 118, 121)]))
        simulate(strategy, ctx, 99)
        self.assertEqual(strategy.position, "FLAT")


class TrainableTrendStrategy:
    def __init__(self, hold=1, **kwargs):
        self.hold = int(hold)
        self.params = {"hold": self.hold}
        self.stop_pct = 0
        self.position = "FLAT"
        self.entry_i = 0
        self.entry_price = 0.0

    def step(self, i, ctx):
        if self.position == "FLAT":
            if i % 20 == 0:
                self.position = "LONG"
                self.entry_i = i
                self.entry_price = ctx.closes[i]
                return "LONG"
            return "HOLD"
        if i - self.entry_i >= self.hold:
            self.position = "FLAT"
            return "FLAT"
        return "HOLD"



class ResearchMetricTests(unittest.TestCase):
    def test_confidence_sharpe_monte_carlo_and_slippage_metrics_are_present(self):
        trades = [
            {"ret": 0.02, "gross_ret": 0.023, "entry_i": 0, "exit_i": 1, "regime": "趋势"},
            {"ret": -0.01, "gross_ret": -0.007, "entry_i": 2, "exit_i": 3, "regime": "横盘"},
            {"ret": 0.015, "gross_ret": 0.018, "entry_i": 4, "exit_i": 5, "regime": "趋势"},
            {"ret": -0.005, "gross_ret": -0.002, "entry_i": 6, "exit_i": 7, "regime": "横盘"},
        ]
        bars = [{"t": i * 3600000, "o": 100, "h": 101, "l": 99, "c": 100, "v": 1} for i in range(8)]
        result = _summarize(trades, [1.0, 1.02, 1.0098, 1.025, 1.03], 4, bars)
        self.assertIsNotNone(result["insample"]["win_rate_ci95"])
        self.assertIsNotNone(result["insample"]["expectancy"])
        self.assertIn("sharpe_per_trade", result["insample"])
        self.assertIn("sortino_per_trade", result["insample"])
        self.assertEqual(result["insample"]["risk_metric_basis"], "per-trade returns; not annualized")
        self.assertEqual(result["monte_carlo"]["full"]["simulations"], 1000)
        self.assertEqual(result["monte_carlo"]["full"]["status"], "ESTIMATE")
        slippage = result["slippage_sensitivity"]
        self.assertEqual([x["extra_slippage_bps_per_side"] for x in slippage], [0, 5, 10, 20, 50])
        self.assertTrue(all(slippage[i]["net_return"] >= slippage[i + 1]["net_return"] for i in range(len(slippage) - 1)))


class WalkForwardTests(unittest.TestCase):
    def test_walk_forward_selects_params_on_past_only_then_runs_isolated_oos(self):
        bars = []
        for i in range(1500):
            close = 100.0 + i * 0.1
            bars.append({
                "t": i * 4 * 60 * 60 * 1000,
                "o": close - 0.05,
                "h": close + 0.1,
                "l": close - 0.1,
                "c": close,
                "v": 100.0,
            })
        ctx = Context(bars, [])
        folds = walk_forward_oos(
            TrainableTrendStrategy,
            ctx,
            {"hold": [1, 5]},
            folds=3,
            oos_days=10,
            min_train_trades=10,
        )
        self.assertEqual(len(folds), 3)
        for fold in folds:
            self.assertEqual(fold["status"], "VALIDATED")
            self.assertEqual(fold["selected_params"]["hold"], 5)
            self.assertGreaterEqual(fold["train_n"], 10)
            self.assertGreater(fold["n"], 0)
            self.assertIsNotNone(fold["net"])
            self.assertLess(fold["start_ms"], fold["end_ms"])


if __name__ == "__main__":
    unittest.main()
