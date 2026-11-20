const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient } = require("../dashboard/assets/paper-ledger-client.js");

test("creates a same-origin session, appends a snapshot, and restores the latest account", async () => {
  const events = [];
  let sessions = 0;
  const fetch = async (url, init = {}) => {
    if (url.endsWith("/api/paper/session")) {
      sessions++;
      return new Response(JSON.stringify({ ok: true, session: "created" }), { status: 200 });
    }
    if (url.includes("/api/paper/ledger") && init.method === "POST") {
      const event = JSON.parse(init.body);
      events.push({ seq: events.length + 1, ...event, createdAt: new Date().toISOString() });
      return new Response(JSON.stringify({ ok: true, accepted: [{ seq: events.length, eventId: event.eventId }] }), { status: 200 });
    }
    if (url.includes("/api/paper/ledger") && init.method === "GET") {
      return new Response(JSON.stringify({ ok: true, events, nextAfter: events.length }), { status: 200 });
    }
    throw new Error("Unexpected URL " + url);
  };
  const client = createClient({ fetch });
  const session = await client.startSession();
  assert.equal(session.available, true);
  await client.appendSnapshot({ version: 1, cash: 9876, positions: {}, orders: [], trades: [] }, { BTCUSDT: 100000 }, "test");
  const restored = await client.latestSnapshot();
  assert.equal(restored.account.cash, 9876);
  assert.equal(restored.event.payload.marks.BTCUSDT, 100000);
  assert.equal(sessions, 1);
});

test("serializes concurrent event writes in invocation order", async () => {
  const received = [];
  const fetch = async (url, init = {}) => {
    if (url.endsWith("/api/paper/session")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (init.method === "POST") {
      received.push(JSON.parse(init.body).eventId);
      return new Response(JSON.stringify({ ok: true, accepted: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, events: [] }), { status: 200 });
  };
  const client = createClient({ fetch });
  await Promise.all([
    client.appendEvent({ eventId: "event-0000001", eventType: "agent.run.started", payload: {} }),
    client.appendEvent({ eventId: "event-0000002", eventType: "agent.run.completed", payload: {} }),
    client.appendEvent({ eventId: "event-0000003", eventType: "risk.decision", payload: {} })
  ]);
  assert.deepEqual(received, ["event-0000001", "event-0000002", "event-0000003"]);
});

test("reports an unavailable optional server ledger without hiding local mode", async () => {
  const fetch = async () => new Response(JSON.stringify({ ok: false, error: "D1 not configured" }), { status: 503 });
  const client = createClient({ fetch });
  await assert.rejects(() => client.startSession(), /D1 not configured/);
  assert.equal(client.getStatus().unavailable, true);
  assert.equal(client.getStatus().ready, false);
});
