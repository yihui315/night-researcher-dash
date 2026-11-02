const test = require("node:test");
const assert = require("node:assert/strict");
const { handlePaperSession } = require("../functions/_lib/paper-ledger.mjs");
const {
  handlePaperAccount,
  handlePaperOrders,
  handlePaperMarketTick,
  handlePaperReplay,
  handlePaperServerEvents,
  __test
} = require("../functions/_lib/paper-server.mjs");

class FakeD1 {
  constructor() {
    this.sessions = new Map();
    this.accounts = new Map();
    this.orders = new Map();
    this.fills = new Map();
    this.events = [];
    this.seq = 1;
  }

  prepare(sql) {
    const db = this;
    const statement = {
      sql,
      args: [],
      bind(...args) { this.args = args; return this; },
      async run() { return db.run(this.sql, this.args); },
      async first() { return db.first(this.sql, this.args); },
      async all() { return db.all(this.sql, this.args); }
    };
    return statement;
  }

  async batch(statements) {
    const backup = {
      sessions: new Map(this.sessions),
      accounts: new Map(this.accounts),
      orders: new Map(this.orders),
      fills: new Map(this.fills),
      events: this.events.map(row => ({ ...row })),
      seq: this.seq
    };
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.sessions = backup.sessions;
      this.accounts = backup.accounts;
      this.orders = backup.orders;
      this.fills = backup.fills;
      this.events = backup.events;
      this.seq = backup.seq;
      throw error;
    }
  }

  async run(sql, args) {
    if (sql.includes("INSERT INTO paper_sessions")) {
      const [sid, createdAt, expiresAt] = args;
      this.sessions.set(sid, { session_id: sid, created_at: createdAt, expires_at: expiresAt, revoked_at: null });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO paper_accounts")) {
      const [sid, version, stateJson, stateHash, commandId, createdAt, updatedAt] = args;
      if (!this.accounts.has(sid)) {
        this.accounts.set(sid, { session_id: sid, version, state_json: stateJson, state_hash: stateHash, last_command_id: commandId, created_at: createdAt, updated_at: updatedAt });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO paper_server_events") && sql.includes("VALUES")) {
      const [sid, eventId, commandId, eventType, schemaVersion, payloadJson, createdAt] = args;
      if (!this.events.some(row => row.session_id === sid && row.event_id === eventId)) {
        this.events.push({ seq: this.seq++, session_id: sid, event_id: eventId, command_id: commandId, event_type: eventType, schema_version: schemaVersion, payload_json: payloadJson, created_at: createdAt });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.startsWith("UPDATE paper_accounts SET state_json")) {
      const [stateJson, version, stateHash, commandId, updatedAt, sid, expectedVersion] = args;
      const row = this.accounts.get(sid);
      if (!row || Number(row.version) !== Number(expectedVersion)) return { success: true, meta: { changes: 0 } };
      this.accounts.set(sid, { ...row, state_json: stateJson, version, state_hash: stateHash, last_command_id: commandId, updated_at: updatedAt });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO paper_orders")) {
      const values = args.slice(0, 25);
      const [sid, version, commandId] = args.slice(25);
      const account = this.accounts.get(sid);
      if (!account || Number(account.version) !== Number(version) || account.last_command_id !== commandId) return { success: true, meta: { changes: 0 } };
      const [
        order_id, session_id, client_order_id, request_hash, confirmation_id, symbol, side, order_type,
        quantity, filled_quantity, remaining_quantity, limit_price, status, average_fill_price, fee,
        realized_pnl, reserved_cash, reserved_quantity, rejection_code, rejection_reason,
        book_sequence, book_received_at, created_at, updated_at, terminal_at
      ] = values;
      const duplicateClient = Array.from(this.orders.values()).find(row => row.session_id === session_id && row.client_order_id === client_order_id && row.order_id !== order_id);
      if (duplicateClient) throw new Error("UNIQUE_SESSION_CLIENT_ORDER");
      this.orders.set(order_id, {
        order_id, session_id, client_order_id, request_hash, confirmation_id, symbol, side, order_type,
        quantity, filled_quantity, remaining_quantity, limit_price, status, average_fill_price, fee,
        realized_pnl, reserved_cash, reserved_quantity, rejection_code, rejection_reason,
        book_sequence, book_received_at, created_at, updated_at, terminal_at
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT OR IGNORE INTO paper_fills")) {
      const values = args.slice(0, 15);
      const [sid, version, commandId] = args.slice(15);
      const account = this.accounts.get(sid);
      if (!account || Number(account.version) !== Number(version) || account.last_command_id !== commandId) return { success: true, meta: { changes: 0 } };
      const [
        fill_id, order_id, session_id, fill_index, symbol, side, quantity, price, notional,
        fee, realized_pnl, liquidity_model, book_sequence, book_received_at, created_at
      ] = values;
      if (this.fills.has(fill_id)) return { success: true, meta: { changes: 0 } };
      this.fills.set(fill_id, {
        fill_id, order_id, session_id, fill_index, symbol, side, quantity, price, notional,
        fee, realized_pnl, liquidity_model, book_sequence, book_received_at, created_at
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT OR IGNORE INTO paper_server_events") && sql.includes("SELECT")) {
      const [sid, eventId, commandId, eventType, payloadJson, createdAt, guardSid, version, guardCommand] = args;
      const schemaVersion = 1;
      const account = this.accounts.get(guardSid);
      if (!account || Number(account.version) !== Number(version) || account.last_command_id !== guardCommand) return { success: true, meta: { changes: 0 } };
      if (this.events.some(row => row.session_id === sid && row.event_id === eventId)) return { success: true, meta: { changes: 0 } };
      this.events.push({ seq: this.seq++, session_id: sid, event_id: eventId, command_id: commandId, event_type: eventType, schema_version: schemaVersion, payload_json: payloadJson, created_at: createdAt });
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error("Unexpected FakeD1.run SQL: " + sql);
  }

  async first(sql, args) {
    if (sql.includes("SELECT session_id, expires_at, revoked_at FROM paper_sessions")) return this.sessions.get(args[0]) || null;
    if (sql.includes("SELECT session_id, version, state_json, state_hash, last_command_id")) return this.accounts.get(args[0]) || null;
    if (sql.includes("FROM paper_orders WHERE session_id = ? AND client_order_id = ?")) {
      return Array.from(this.orders.values()).find(row => row.session_id === args[0] && row.client_order_id === args[1]) || null;
    }
    if (sql.includes("FROM paper_server_events WHERE session_id = ? AND event_id = ?")) {
      return this.events.find(row => row.session_id === args[0] && row.event_id === args[1]) || null;
    }
    throw new Error("Unexpected FakeD1.first SQL: " + sql);
  }

  async all(sql, args) {
    if (sql.includes("FROM paper_server_events") && sql.includes("seq > ?")) {
      const [sid, after, limit] = args;
      return { results: this.events.filter(row => row.session_id === sid && row.seq > after).sort((a,b) => a.seq-b.seq).slice(0, limit) };
    }
    if (sql.includes("FROM paper_server_events") && sql.includes("ORDER BY seq ASC")) {
      const [sid] = args;
      return { results: this.events.filter(row => row.session_id === sid).sort((a,b) => a.seq-b.seq) };
    }
    throw new Error("Unexpected FakeD1.all SQL: " + sql);
  }
}

function makeMarketFetch(options = {}) {
  const state = {
    sequence: options.sequence || 123,
    bids: options.bids || [["99900", "5"], ["99800", "10"]],
    asks: options.asks || [["100000", "5"], ["100100", "10"]]
  };
  const calls = [];
  const fetcher = async input => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/depth")) {
      return Response.json({ lastUpdateId: state.sequence, bids: state.bids, asks: state.asks });
    }
    if (url.pathname.endsWith("/exchangeInfo")) {
      const symbol = url.searchParams.get("symbol");
      return Response.json({ symbols: [{
        symbol,
        status: "TRADING",
        filters: [
          { filterType: "LOT_SIZE", minQty: "0.000001", maxQty: "1000", stepSize: "0.000001" },
          { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "10000000", tickSize: "0.01" },
          { filterType: "MIN_NOTIONAL", minNotional: "5" }
        ]
      }] });
    }
    if (url.pathname.endsWith("/ticker/price")) {
      return Response.json([
        { symbol: "BTCUSDT", price: "100000" },
        { symbol: "ETHUSDT", price: "3000" },
        { symbol: "ORDIUSDT", price: "10" },
        { symbol: "1000SATSUSDT", price: "0.00001" }
      ]);
    }
    return new Response("not found", { status: 404 });
  };
  fetcher.state = state;
  fetcher.calls = calls;
  return fetcher;
}

const SECRET = "paper-server-test-secret-with-at-least-thirty-two-characters";
function envWith(fetcher) {
  return { PAPER_DB: new FakeD1(), PAPER_LEDGER_SECRET: SECRET, __fetch: fetcher };
}
function cookieFrom(response) { return response.headers.get("set-cookie").split(";")[0]; }
function makeRequest(url, method, cookie, body) {
  return new Request(url, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { origin: "https://nr.example" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}
async function createSession(env) {
  const response = await handlePaperSession(new Request("https://nr.example/api/paper/session", {
    method: "POST",
    headers: { origin: "https://nr.example", "content-type": "application/json" },
    body: "{}"
  }), env);
  assert.equal(response.status, 200);
  return cookieFrom(response);
}
function orderInput(overrides = {}) {
  return {
    clientOrderId: "client-order-0001",
    confirmationId: "confirm-order-0001",
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: 0.005,
    ...overrides
  };
}

test("D1 paper account bootstraps server-side with no browser-supplied balance", async () => {
  const env = envWith(makeMarketFetch());
  const cookie = await createSession(env);
  const response = await handlePaperAccount(makeRequest("https://nr.example/api/paper/account", "GET", cookie), env);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.mode, "server-authoritative-paper");
  assert.equal(data.account.cash, 10000);
  assert.equal(data.account.version, 1);
  assert.equal(env.PAPER_DB.accounts.size, 1);
  assert.equal(env.PAPER_DB.events.filter(event => event.event_type === "paper.server.account.snapshot").length, 1);
});

test("market order re-reads Binance depth and exchange filters on the server, then persists account order fill and events", async () => {
  const fetcher = makeMarketFetch();
  const env = envWith(fetcher);
  const cookie = await createSession(env);
  const response = await handlePaperOrders(
    makeRequest("https://nr.example/api/paper/orders", "POST", cookie, orderInput()),
    env
  );
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.accepted, true);
  assert.equal(data.order.status, "FILLED");
  assert.equal(data.fills.length, 1);
  assert.equal(data.account.cash, 9499.5);
  assert.equal(data.account.positions.BTCUSDT.qty, 0.005);
  assert.equal(env.PAPER_DB.orders.size, 1);
  assert.equal(env.PAPER_DB.fills.size, 1);
  assert.ok(fetcher.calls.some(call => call.includes("/depth?symbol=BTCUSDT")));
  assert.ok(fetcher.calls.some(call => call.includes("/exchangeInfo?symbol=BTCUSDT")));
  assert.ok(fetcher.calls.some(call => call.includes("/ticker/price?symbols=")));
  assert.ok(env.PAPER_DB.events.some(event => event.event_type === "paper.server.order.filled"));
});

test("client book, account and fill fields are rejected; browser cannot forge the server execution inputs", async () => {
  const env = envWith(makeMarketFetch());
  const cookie = await createSession(env);
  const response = await handlePaperOrders(
    makeRequest("https://nr.example/api/paper/orders", "POST", cookie, { ...orderInput(), book: { asks: [[1, 100]] }, account: { cash: 1 } }),
    env
  );
  assert.equal(response.status, 400);
  assert.equal(env.PAPER_DB.orders.size, 0);
});

test("client order id is idempotent and cannot be reused with different order parameters", async () => {
  const env = envWith(makeMarketFetch());
  const cookie = await createSession(env);
  const request = () => makeRequest("https://nr.example/api/paper/orders", "POST", cookie, orderInput());
  const first = await handlePaperOrders(request(), env);
  const duplicate = await handlePaperOrders(request(), env);
  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(env.PAPER_DB.orders.size, 1);
  assert.equal(env.PAPER_DB.fills.size, 1);

  const conflict = await handlePaperOrders(
    makeRequest("https://nr.example/api/paper/orders", "POST", cookie, orderInput({ quantity: 0.006 })),
    env
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "IDEMPOTENCY_CONFLICT");
  assert.equal(env.PAPER_DB.fills.size, 1);
});

test("limit orders reserve cash, partially fill once per book sequence, then finish and release reservations", async () => {
  const fetcher = makeMarketFetch();
  const env = envWith(fetcher);
  const cookie = await createSession(env);
  const input = orderInput({
    clientOrderId: "client-limit-0001",
    confirmationId: "confirm-limit-0001",
    type: "LIMIT",
    quantity: 0.005,
    limitPrice: 99000
  });
  const created = await handlePaperOrders(makeRequest("https://nr.example/api/paper/orders", "POST", cookie, input), env);
  const createdData = await created.json();
  assert.equal(created.status, 201);
  assert.equal(createdData.order.status, "OPEN");
  assert.ok(createdData.account.reservedCash > 0);

  fetcher.state.sequence = 124;
  fetcher.state.asks = [["99000", "0.002"], ["99010", "5"]];
  fetcher.state.bids = [["98900", "5"]];
  const firstTick = await handlePaperMarketTick(makeRequest("https://nr.example/api/paper/market/tick", "POST", cookie, { symbol: "BTCUSDT" }), env);
  const firstData = await firstTick.json();
  assert.equal(firstTick.status, 200);
  assert.equal(firstData.changed, true);
  assert.equal(firstData.account.orders[0].status, "PARTIALLY_FILLED");
  assert.equal(firstData.account.orders[0].filledQty, 0.002);
  assert.ok(firstData.account.reservedCash > 0);

  const duplicateTick = await handlePaperMarketTick(makeRequest("https://nr.example/api/paper/market/tick", "POST", cookie, { symbol: "BTCUSDT" }), env);
  assert.equal((await duplicateTick.json()).reason, "BOOK_SEQUENCE_ALREADY_PROCESSED");
  assert.equal(env.PAPER_DB.fills.size, 1);

  fetcher.state.sequence = 125;
  fetcher.state.asks = [["99000", "0.003"]];
  const secondTick = await handlePaperMarketTick(makeRequest("https://nr.example/api/paper/market/tick", "POST", cookie, { symbol: "BTCUSDT" }), env);
  const secondData = await secondTick.json();
  assert.equal(secondTick.status, 200);
  assert.equal(secondData.account.orders[0].status, "FILLED");
  assert.equal(secondData.account.orders[0].filledQty, 0.005);
  assert.equal(secondData.account.reservedCash, 0);
  assert.equal(env.PAPER_DB.fills.size, 2);
  assert.deepEqual(Array.from(env.PAPER_DB.fills.values()).map(fill => fill.fill_index).sort(), [1, 2]);
});

test("same-origin protection rejects cross-site order submission", async () => {
  const env = envWith(makeMarketFetch());
  const cookie = await createSession(env);
  const request = new Request("https://nr.example/api/paper/orders", {
    method: "POST",
    headers: { cookie, origin: "https://attacker.example", "content-type": "application/json" },
    body: JSON.stringify(orderInput())
  });
  const response = await handlePaperOrders(request, env);
  assert.equal(response.status, 403);
  assert.equal(env.PAPER_DB.orders.size, 0);
});

test("optimistic account versioning allows only one of two concurrent orders to commit", async () => {
  const fetcher = makeMarketFetch();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let arrivals = 0;
  const barrierFetch = async (url, init) => {
    arrivals++;
    if (arrivals === 6) release();
    await gate;
    return fetcher(url, init);
  };
  const env = envWith(barrierFetch);
  const cookie = await createSession(env);
  const first = handlePaperOrders(makeRequest("https://nr.example/api/paper/orders", "POST", cookie, orderInput({
    clientOrderId: "client-race-0001", confirmationId: "confirm-race-0001", quantity: 0.005
  })), env);
  const second = handlePaperOrders(makeRequest("https://nr.example/api/paper/orders", "POST", cookie, orderInput({
    clientOrderId: "client-race-0002", confirmationId: "confirm-race-0002", quantity: 0.006
  })), env);
  const results = await Promise.all([first, second]);
  const statuses = results.map(response => response.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.equal(env.PAPER_DB.orders.size, 1);
  assert.equal(env.PAPER_DB.fills.size, 1);
});

test("event replay verifies the hash-linked account snapshots and returns the recoverable account", async () => {
  const env = envWith(makeMarketFetch());
  const cookie = await createSession(env);
  await handlePaperOrders(makeRequest("https://nr.example/api/paper/orders", "POST", cookie, orderInput()), env);
  const response = await handlePaperReplay(makeRequest("https://nr.example/api/paper/replay", "GET", cookie), env);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.verified, true);
  assert.equal(data.snapshots, 2);
  assert.equal(data.account.cash, 9499.5);
  const events = await handlePaperServerEvents(makeRequest("https://nr.example/api/paper/events?after=0&limit=100", "GET", cookie), env);
  assert.ok((await events.json()).events.some(event => event.eventType === "paper.server.order.created"));
});

test("server risk rejection is persisted as an immutable order and risk event", async () => {
  const env = envWith(makeMarketFetch());
  const cookie = await createSession(env);
  const response = await handlePaperOrders(
    makeRequest("https://nr.example/api/paper/orders", "POST", cookie, orderInput({ quantity: 0.02 })),
    env
  );
  const data = await response.json();
  assert.equal(response.status, 409);
  assert.equal(data.order.status, "REJECTED");
  assert.match(data.order.reason, /单笔风险上限/);
  assert.equal(env.PAPER_DB.orders.size, 1);
  assert.equal(env.PAPER_DB.fills.size, 0);
  assert.ok(env.PAPER_DB.events.some(event => event.event_type === "paper.server.order.rejected"));
});

test("paper server routes fail closed without D1 or a strong signing secret", async () => {
  const noDb = await handlePaperAccount(new Request("https://nr.example/api/paper/account"), {});
  assert.equal(noDb.status, 503);
  const weak = await handlePaperAccount(new Request("https://nr.example/api/paper/account"), {
    PAPER_DB: new FakeD1(),
    PAPER_LEDGER_SECRET: "short"
  });
  assert.equal(weak.status, 503);
});

test("pure server execution helpers reject unsorted books and invalid exchange quantity steps", () => {
  assert.throws(() => __test.normalizeLevels([["100", "1"], ["101", "1"]], true), /MARKET_BOOK_UNSORTED/);
  assert.equal(__test.stepValid(0.005, 0.001), true);
  assert.equal(__test.stepValid(0.0055, 0.001), false);
  const walk = __test.walkBook([[100, 0.002], [101, 0.003]], 0.004);
  assert.equal(walk.filledQty, 0.004);
  assert.equal(walk.remainingQty, 0);
  assert.equal(walk.avgPrice, 100.25);
});
