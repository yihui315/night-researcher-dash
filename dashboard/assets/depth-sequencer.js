(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.NRDepthBook = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function create(limit) {
    return { limit: Number(limit || 20), lastUpdateId: 0, bids: new Map(), asks: new Map(), synced: false };
  }
  function applyLevels(target, levels) {
    for (const level of levels || []) {
      const price = Number(level[0]), qty = Number(level[1]);
      if (!(price > 0) || !Number.isFinite(qty) || qty < 0) continue;
      if (qty === 0) target.delete(price);
      else target.set(price, qty);
    }
  }
  function loadSnapshot(book, snapshot) {
    if (!snapshot || !Number.isFinite(Number(snapshot.lastUpdateId))) throw new Error("Invalid depth snapshot");
    book.bids.clear(); book.asks.clear();
    applyLevels(book.bids, snapshot.bids);
    applyLevels(book.asks, snapshot.asks);
    book.lastUpdateId = Number(snapshot.lastUpdateId);
    book.synced = true;
    return levels(book);
  }
  function applyDiff(book, event) {
    if (!book.synced) return { status: "unsynced" };
    const first = Number(event && event.U), last = Number(event && event.u);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return { status: "invalid" };
    if (last <= book.lastUpdateId) return { status: "stale", lastUpdateId: book.lastUpdateId };
    const expected = book.lastUpdateId + 1;
    if (first > expected) {
      book.synced = false;
      return { status: "gap", expected, received: first, lastUpdateId: book.lastUpdateId };
    }
    if (first <= expected && last >= expected) {
      applyLevels(book.bids, event.b || event.bids);
      applyLevels(book.asks, event.a || event.asks);
      book.lastUpdateId = last;
      return { status: "applied", lastUpdateId: last, book: levels(book) };
    }
    return { status: "ignored", lastUpdateId: book.lastUpdateId };
  }
  function levels(book) {
    const bids = Array.from(book.bids, ([price, qty]) => [String(price), String(qty)])
      .sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, book.limit);
    const asks = Array.from(book.asks, ([price, qty]) => [String(price), String(qty)])
      .sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, book.limit);
    return { lastUpdateId: book.lastUpdateId, bids, asks, synced: book.synced };
  }
  return { create, loadSnapshot, applyDiff, levels };
});
