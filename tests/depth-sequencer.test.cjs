const test = require("node:test");
const assert = require("node:assert/strict");
const Depth = require("../dashboard/assets/depth-sequencer.js");

test("loads a REST snapshot and applies the first bridging diff event", () => {
  const book = Depth.create(20);
  Depth.loadSnapshot(book, {
    lastUpdateId: 100,
    bids: [["100", "2"], ["99", "3"]],
    asks: [["101", "4"], ["102", "5"]]
  });
  const result = Depth.applyDiff(book, {
    U: 100, u: 101, b: [["100", "0"], ["100.5", "1.5"]], a: [["101", "2"]]
  });
  assert.equal(result.status, "applied");
  assert.equal(result.lastUpdateId, 101);
  assert.deepEqual(result.book.bids[0], ["100.5", "1.5"]);
  assert.deepEqual(result.book.asks[0], ["101", "2"]);
});

test("ignores stale diff events without changing the sequence", () => {
  const book = Depth.create(20);
  Depth.loadSnapshot(book, { lastUpdateId: 200, bids: [["10", "1"]], asks: [["11", "1"]] });
  assert.equal(Depth.applyDiff(book, { U: 190, u: 200, b: [["10", "9"]], a: [] }).status, "stale");
  assert.equal(book.lastUpdateId, 200);
  assert.equal(Depth.levels(book).bids[0][1], "1");
});

test("detects a sequence gap and forces a fresh snapshot", () => {
  const book = Depth.create(20);
  Depth.loadSnapshot(book, { lastUpdateId: 300, bids: [["10", "1"]], asks: [["11", "1"]] });
  const result = Depth.applyDiff(book, { U: 302, u: 303, b: [], a: [] });
  assert.equal(result.status, "gap");
  assert.equal(result.expected, 301);
  assert.equal(book.synced, false);
});

test("deletes zero-quantity levels and sorts the resulting book", () => {
  const book = Depth.create(3);
  Depth.loadSnapshot(book, {
    lastUpdateId: 400,
    bids: [["10", "1"], ["12", "1"], ["11", "1"]],
    asks: [["13", "1"], ["15", "1"], ["14", "1"]]
  });
  const result = Depth.applyDiff(book, { U: 401, u: 401, b: [["12", "0"], ["9", "2"]], a: [["13", "0"], ["12.5", "3"]] });
  assert.equal(result.status, "applied");
  assert.deepEqual(result.book.bids, [["11", "1"], ["10", "1"], ["9", "2"]]);
  assert.deepEqual(result.book.asks, [["12.5", "3"], ["14", "1"], ["15", "1"]]);
});
