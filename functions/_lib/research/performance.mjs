// Performance / risk metrics for a set of (simulated or backtest) trades/samples.
//
// Monetary sums (net pnl, fees, slippage) use the repo's fixed-point decimal module (BigInt 1e8)
// to avoid IEEE-754 drift. Ratio metrics (win rate, P/L ratio, Sharpe, drawdown) are computed as
// plain numbers. ALL inputs are real figures passed in — this module never fabricates numbers.

import { D, U, add, sub } from "../decimal.mjs";

// Compute per-trade net pnl if not supplied.
function netOf(trade) {
  if (typeof trade.pnl === "number" && Number.isFinite(trade.pnl)) {
    return trade.pnl - (trade.fee || 0) - (trade.slippage || 0);
  }
  const direction = trade.side === "SELL" ? -1 : 1; // SELL opens short; net = (entry-exit)*qty
  const gross = direction * (trade.exitPrice - trade.entryPrice) * trade.qty;
  return gross - (trade.fee || 0) - (trade.slippage || 0);
}

export function computePerformance(input = {}) {
  const trades = Array.isArray(input.trades) ? input.trades : [];
  const initialEquity = typeof input.initialEquity === "number" && input.initialEquity > 0 ? input.initialEquity : 10000;
  const riskRejections = Number(input.riskRejections) || 0;
  const strategyDeactivations = Number(input.strategyDeactivations) || 0;
  const sampleCount = input.sampleCount != null ? Number(input.sampleCount) : trades.length;

  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let fees = D(0);
  let slippage = D(0);
  let netPnl = D(0);
  const equityCurve = [initialEquity];
  const returns = [];

  for (const trade of trades) {
    const net = netOf(trade);
    const isWin = net > 0;
    if (isWin) { wins++; grossProfit += net; } else { losses++; grossLoss += Math.abs(net); }
    fees = add(fees, D(trade.fee || 0));
    slippage = add(slippage, D(trade.slippage || 0));
    netPnl = add(netPnl, D(net));
    const prev = equityCurve[equityCurve.length - 1];
    const next = prev + net;
    equityCurve.push(next);
    returns.push(net / initialEquity);
  }

  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const profitLossRatio = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0);
  const avgWin = wins > 0 ? grossProfit / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;

  // Max drawdown over the equity curve (fraction of peak).
  let peak = equityCurve[0];
  let maxDrawdown = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    if (peak > 0) {
      const dd = (peak - eq) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  // Per-trade Sharpe (not annualized): mean / std of trade returns.
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length
    ? returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / returns.length
    : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? mean / std : 0;

  return {
    sampleCount,
    totalTrades,
    wins,
    losses,
    winRate,
    profitLossRatio,
    avgWin,
    avgLoss,
    grossProfit,
    grossLoss,
    fees: Number(U(fees)),
    slippage: Number(U(slippage)),
    netPnl: Number(U(netPnl)),
    netPnlScaled: U(netPnl),
    maxDrawdown,
    sharpe,
    riskRejections,
    strategyDeactivations
  };
}

// Build a deterministic set of sample trades from a generated price series using a simple,
// transparent mean-reversion rule. Trades are DERIVED from the data (not fabricated): enter
// long when price < SMA(lookback); exit when price >= SMA or stop. Returns trade objects the
// performance module can consume.
export function simulateSampleTrades(prices, opts = {}) {
  const lookback = opts.lookback || 5;
  const feeRate = opts.feeRate != null ? opts.feeRate : 0.001;
  const slippageRate = opts.slippageRate != null ? opts.slippageRate : 0.0005;
  const qty = opts.qty || 1;
  const trades = [];
  let position = null;
  const sma = (i) => {
    const start = Math.max(0, i - lookback + 1);
    let s = 0;
    for (let k = start; k <= i; k++) s += prices[k];
    return s / (i - start + 1);
  };
  for (let i = lookback; i < prices.length; i++) {
    const price = prices[i];
    const mean = sma(i);
    if (!position && price < mean * 0.997) {
      position = { entryPrice: price, entryIndex: i };
    } else if (position && (price >= mean || i === prices.length - 1)) {
      const exitPrice = price;
      const notional = exitPrice * qty;
      const fee = notional * feeRate;
      const slip = notional * slippageRate;
      trades.push({ symbol: opts.symbol || "SIM", side: "BUY", entryPrice: position.entryPrice, exitPrice, qty, fee, slippage: slip });
      position = null;
    }
  }
  return trades;
}
