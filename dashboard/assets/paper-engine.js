(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.NRPaper = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const STORAGE_KEY = "night-researcher.paper.v1";
  const CFG = { initialCash: 10000, feeRate: 0.001, minNotional: 5, maxOrderPct: 0.10, maxExposurePct: 0.40, dailyLossPct: 0.03, maxDrawdownPct: 0.10 };
  const round = (n, d) => Number(Number(n).toFixed(d == null ? 10 : d));
  const today = () => new Date().toISOString().slice(0, 10);
  function createAccount(initialCash) {
    const cash = Number(initialCash || CFG.initialCash);
    return { version: 1, initialCash: cash, cash, reservedCash: 0, positions: {}, orders: [], trades: [], realizedPnl: 0, equityPeak: cash, dayKey: today(), dayStartEquity: cash, nextId: 1, createdAt: new Date().toISOString() };
  }
  function loadAccount() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createAccount();
      const a = JSON.parse(raw);
      if (!a || a.version !== 1 || !Number.isFinite(a.cash) || !a.positions) return createAccount();
      a.reservedCash = Number(a.reservedCash || 0);
      a.orders = Array.isArray(a.orders) ? a.orders : [];
      a.trades = Array.isArray(a.trades) ? a.trades : [];
      a.nextId = Number(a.nextId || 1);
      return a;
    } catch (_) { return createAccount(); }
  }
  function saveAccount(account) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(account)); return true; }
    catch (_) { return false; }
  }
  function equityNow(account, marks) {
    let value = account.cash;
    Object.keys(account.positions).forEach(symbol => {
      const p = account.positions[symbol];
      const mark = Number(marks[symbol] || p.avgPrice || 0);
      value += p.qty * mark;
    });
    return value;
  }
  function summary(account, marks) {
    const equity = equityNow(account, marks);
    const day = today();
    if (account.dayKey !== day) { account.dayKey = day; account.dayStartEquity = equity; }
    account.equityPeak = Math.max(Number(account.equityPeak || account.initialCash), equity);
    let marketValue = 0, unrealized = 0;
    const positions = [];
    Object.keys(account.positions).forEach(symbol => {
      const p = account.positions[symbol], mark = Number(marks[symbol] || p.avgPrice || 0);
      const value = p.qty * mark, pnl = value - p.qty * p.avgPrice;
      marketValue += value; unrealized += pnl;
      positions.push({ symbol, qty: p.qty, avgPrice: p.avgPrice, mark, marketValue: value, unrealizedPnl: pnl, reservedQty: p.reservedQty || 0 });
    });
    const drawdown = account.equityPeak > 0 ? Math.max(0, (account.equityPeak - equity) / account.equityPeak) : 0;
    const dailyPnl = equity - account.dayStartEquity;
    return { equity, cash: account.cash, availableCash: account.cash - account.reservedCash, reservedCash: account.reservedCash, marketValue, unrealizedPnl: unrealized, realizedPnl: account.realizedPnl, totalPnl: equity - account.initialCash, dailyPnl, drawdown, exposurePct: equity > 0 ? marketValue / equity : 0, positions, dailyLossLocked: dailyPnl <= -account.dayStartEquity * CFG.dailyLossPct, drawdownLocked: drawdown >= CFG.maxDrawdownPct };
  }
  function walkBook(levels, qty) {
    let remaining = qty, notional = 0, filled = 0;
    for (const level of (levels || [])) {
      const price = Number(level[0]), available = Number(level[1]);
      if (!(price > 0) || !(available > 0)) continue;
      const take = Math.min(remaining, available);
      notional += take * price; filled += take; remaining -= take;
      if (remaining <= Math.max(1e-12, qty * 1e-9)) break;
    }
    if (remaining > Math.max(1e-12, qty * 1e-9)) return null;
    return { qty: filled, notional, avgPrice: notional / filled };
  }
  function eligibleLevels(side, type, limitPrice, book) {
    const levels = side === "BUY" ? (book.asks || []) : (book.bids || []);
    if (type !== "LIMIT") return levels;
    return levels.filter(level => side === "BUY" ? Number(level[0]) <= limitPrice : Number(level[0]) >= limitPrice);
  }
  function nextId(account, prefix) { const id = prefix + String(account.nextId++).padStart(6, "0"); return id; }
  function pushLimited(list, item, max) { list.unshift(item); if (list.length > max) list.length = max; }
  function reservedBuyExposure(account, exceptId) {
    return account.orders.filter(o => o.status === "OPEN" && o.side === "BUY" && o.id !== exceptId).reduce((sum, o) => sum + Number(o.qty) * Number(o.limitPrice || 0), 0);
  }
  function releaseReservation(account, order) {
    if (order.reservedCash) { account.reservedCash = Math.max(0, account.reservedCash - order.reservedCash); order.reservedCash = 0; }
    if (order.reservedQty) {
      const p = account.positions[order.symbol];
      if (p) p.reservedQty = Math.max(0, (p.reservedQty || 0) - order.reservedQty);
      order.reservedQty = 0;
    }
  }
  function applyFill(account, order, fill) {
    const fee = fill.notional * CFG.feeRate;
    if (order.side === "BUY") {
      const cost = fill.notional + fee;
      if (cost > account.cash - account.reservedCash + 1e-8) throw new Error("可用 USDT 不足");
      let p = account.positions[order.symbol];
      if (!p) p = account.positions[order.symbol] = { qty: 0, avgPrice: 0, reservedQty: 0 };
      p.avgPrice = ((p.qty * p.avgPrice) + cost) / (p.qty + fill.qty);
      p.qty += fill.qty;
      account.cash -= cost;
    } else {
      const p = account.positions[order.symbol];
      if (!p || fill.qty > p.qty - (p.reservedQty || 0) + 1e-10) throw new Error("可卖持仓不足");
      const realized = fill.notional - fee - p.avgPrice * fill.qty;
      p.qty -= fill.qty;
      account.cash += fill.notional - fee;
      account.realizedPnl += realized;
      order.realizedPnl = realized;
      if (p.qty <= 1e-10) delete account.positions[order.symbol];
    }
    order.status = "FILLED";
    order.filledQty = fill.qty;
    order.avgFillPrice = fill.avgPrice;
    order.fee = fee;
    order.filledAt = new Date().toISOString();
    const trade = { id: nextId(account, "T"), orderId: order.id, timestamp: order.filledAt, symbol: order.symbol, side: order.side, qty: fill.qty, price: fill.avgPrice, notional: fill.notional, fee, realizedPnl: order.realizedPnl == null ? null : order.realizedPnl, liquidityModel: "visible-orderbook-walk" };
    pushLimited(account.trades, trade, 300);
    return trade;
  }
  function validateOrder(account, params, marks, book) {
    const symbol = String(params.symbol || "");
    const side = String(params.side || "").toUpperCase();
    const type = String(params.type || "MARKET").toUpperCase();
    const qty = Number(params.qty);
    const limitPrice = Number(params.limitPrice || 0);
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new Error("暂不支持该交易对");
    if (side !== "BUY" && side !== "SELL") throw new Error("订单方向无效");
    if (type !== "MARKET" && type !== "LIMIT") throw new Error("订单类型无效");
    if (!(qty > 0) || !Number.isFinite(qty)) throw new Error("请输入有效数量");
    if (type === "LIMIT" && !(limitPrice > 0)) throw new Error("请输入有效限价");
    const best = side === "BUY" ? (book.asks || [])[0] : (book.bids || [])[0];
    const ref = type === "LIMIT" ? limitPrice : Number(best && best[0] || marks[symbol] || 0);
    if (!(ref > 0)) throw new Error("等待真实盘口报价后再下单");
    const notional = qty * ref;
    if (notional < CFG.minNotional) throw new Error("订单金额低于模拟最低门槛 $5");
    const snap = summary(account, marks);
    if (notional > snap.equity * CFG.maxOrderPct + 1e-8) throw new Error("超过单笔风险上限（账户净值的 10%）");
    if (side === "BUY") {
      if (snap.dailyLossLocked) throw new Error("触发单日亏损熔断，暂停新增买入");
      if (snap.drawdownLocked) throw new Error("触发账户回撤熔断，暂停新增买入");
      if (snap.marketValue + reservedBuyExposure(account) + notional > snap.equity * CFG.maxExposurePct + 1e-8) throw new Error("超过总持仓敞口上限（账户净值的 40%）");
      if (type === "MARKET" && notional * (1 + CFG.feeRate) > snap.availableCash + 1e-8) throw new Error("可用 USDT 不足");
      if (type === "LIMIT" && notional * (1 + CFG.feeRate) > snap.availableCash + 1e-8) throw new Error("可用 USDT 不足，无法冻结限价委托金额");
    } else {
      const p = account.positions[symbol];
      const available = p ? p.qty - (p.reservedQty || 0) : 0;
      if (qty > available + 1e-10) throw new Error("现货模拟账户没有足够可卖持仓；不支持裸卖空");
    }
    return { symbol, side, type, qty, limitPrice, notional };
  }
  function placeOrder(account, params, book, marks) {
    const p = validateOrder(account, params, marks, book);
    const order = { id: nextId(account, "O"), symbol: p.symbol, side: p.side, type: p.type, qty: p.qty, limitPrice: p.type === "LIMIT" ? p.limitPrice : null, status: "NEW", createdAt: new Date().toISOString(), filledQty: 0 };
    if (p.type === "MARKET") {
      const fill = walkBook(eligibleLevels(p.side, p.type, 0, book), p.qty);
      if (!fill) throw new Error("可见盘口深度不足，未模拟成交；请降低数量或等待深度更新");
      if (p.side === "BUY") {
        const snap = summary(account, marks);
        if (fill.notional > snap.equity * CFG.maxOrderPct + 1e-8 || snap.marketValue + reservedBuyExposure(account) + fill.notional > snap.equity * CFG.maxExposurePct + 1e-8) throw new Error("盘口冲击使实际成交金额超过风险上限，未模拟成交");
      }
      applyFill(account, order, fill);
      pushLimited(account.orders, order, 300);
      return { status: "FILLED", order };
    }
    const levels = eligibleLevels(p.side, "LIMIT", p.limitPrice, book);
    const immediate = walkBook(levels, p.qty);
    if (immediate) {
      applyFill(account, order, immediate);
      pushLimited(account.orders, order, 300);
      return { status: "FILLED", order };
    }
    if (p.side === "BUY") {
      order.reservedCash = p.notional * (1 + CFG.feeRate);
      account.reservedCash += order.reservedCash;
    } else {
      order.reservedQty = p.qty;
      account.positions[p.symbol].reservedQty = (account.positions[p.symbol].reservedQty || 0) + p.qty;
    }
    order.status = "OPEN";
    pushLimited(account.orders, order, 300);
    return { status: "OPEN", order };
  }
  function processOpenOrders(account, symbol, book, marks) {
    const updates = [];
    account.orders.filter(o => o.status === "OPEN" && o.symbol === symbol).forEach(order => {
      const levels = eligibleLevels(order.side, "LIMIT", order.limitPrice, book);
      const fill = walkBook(levels, order.qty);
      if (!fill) return;
      releaseReservation(account, order);
      try {
        if (order.side === "BUY") {
          const snap = summary(account, marks);
          if (snap.marketValue + reservedBuyExposure(account, order.id) + fill.notional > snap.equity * CFG.maxExposurePct + 1e-8) throw new Error("账户敞口已变化，限价单拒绝成交");
        }
        applyFill(account, order, fill);
        updates.push({ id: order.id, status: "FILLED" });
      } catch (err) {
        order.status = "REJECTED";
        order.reason = err.message;
        updates.push({ id: order.id, status: "REJECTED", reason: err.message });
      }
    });
    return updates;
  }
  function cancelOrder(account, orderId) {
    const order = account.orders.find(o => o.id === orderId && o.status === "OPEN");
    if (!order) return false;
    releaseReservation(account, order);
    order.status = "CANCELED";
    order.canceledAt = new Date().toISOString();
    return true;
  }
  function resetAccount() { return createAccount(); }
  return { CFG, STORAGE_KEY, createAccount, loadAccount, saveAccount, summary, walkBook, placeOrder, processOpenOrders, cancelOrder, resetAccount };
});