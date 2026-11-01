const test = require("node:test");
const assert = require("node:assert/strict");
const Paper = require("../dashboard/assets/paper-engine.js");

function book(bid, ask, depth) {
  return {
    bids: [[String(bid), String(depth || 10)]],
    asks: [[String(ask), String(depth || 10)]]
  };
}
test("market buy walks the visible ask book and charges a 0.1% fee", () => {
  const account = Paper.createAccount(10000);
  const result = Paper.placeOrder(account, { symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: 0.005 }, book(99900, 100000, 1), { BTCUSDT: 100000 });
  assert.equal(result.status, "FILLED");
  assert.equal(result.order.avgFillPrice, 100000);
  assert.ok(Math.abs(account.cash - (10000 - 500.5)) < 1e-8);
  assert.equal(account.trades.length, 1);
});
test("spot paper account rejects naked sells and oversized orders", () => {
  const account = Paper.createAccount(10000);
  assert.throws(() => Paper.placeOrder(account, { symbol: "BTCUSDT", side: "SELL", type: "MARKET", qty: 0.001 }, book(99900, 100000), { BTCUSDT: 100000 }), /没有足够可卖持仓/);
  assert.throws(() => Paper.placeOrder(account, { symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: 0.02 }, book(99900, 100000), { BTCUSDT: 100000 }), /单笔风险上限/);
});
test("market order refuses to invent a fill when visible depth is insufficient", () => {
  const account = Paper.createAccount(10000);
  assert.throws(() => Paper.placeOrder(account, { symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: 0.009 }, book(99900, 100000, 0.001), { BTCUSDT: 100000 }), /盘口深度不足/);
  assert.equal(account.trades.length, 0);
});
test("non-marketable limit buy reserves cash and can be canceled", () => {
  const account = Paper.createAccount(10000);
  const result = Paper.placeOrder(account, { symbol: "BTCUSDT", side: "BUY", type: "LIMIT", qty: 0.001, limitPrice: 90000 }, book(89900, 90100), { BTCUSDT: 90000 });
  assert.equal(result.status, "OPEN");
  assert.ok(account.reservedCash > 0);
  assert.equal(Paper.cancelOrder(account, result.order.id), true);
  assert.equal(account.reservedCash, 0);
});
test("limit order fills only when eligible visible liquidity reaches its price", () => {
  const account = Paper.createAccount(10000);
  const result = Paper.placeOrder(account, { symbol: "BTCUSDT", side: "BUY", type: "LIMIT", qty: 0.001, limitPrice: 90000 }, book(89900, 90100), { BTCUSDT: 90000 });
  assert.equal(result.status, "OPEN");
  const updates = Paper.processOpenOrders(account, "BTCUSDT", { bids: [["89900","5"]], asks: [["89950","1"]] }, { BTCUSDT: 89950 });
  assert.equal(updates[0].status, "FILLED");
  assert.equal(account.positions.BTCUSDT.qty, 0.001);
});
test("summary marks open positions to market and reports exposure", () => {
  const account = Paper.createAccount(10000);
  Paper.placeOrder(account, { symbol: "ETHUSDT", side: "BUY", type: "MARKET", qty: 0.1 }, book(2990, 3000, 10), { ETHUSDT: 3000 });
  const s = Paper.summary(account, { ETHUSDT: 3100 });
  assert.ok(s.unrealizedPnl > 0);
  assert.ok(s.exposurePct > 0);
});