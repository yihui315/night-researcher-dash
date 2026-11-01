import unittest

from backtest_engine import simulate


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


if __name__ == "__main__":
    unittest.main()
