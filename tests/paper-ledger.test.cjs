const test = require("node:test");
const assert = require("node:assert/strict");
const { handlePaperSession, handlePaperLedger } = require("../functions/_lib/paper-ledger.mjs");

class FakeD1 {
  constructor() { this.sessions = new Map(); this.events = []; this.seq = 1; }
  prepare(sql) {
    const db = this;
    return { bind(...args) {
      return {
        async run() {
          if (sql.includes("INSERT INTO paper_sessions")) {
            const [sid, createdAt, expiresAt] = args;
            db.sessions.set(sid, { session_id: sid, created_at: createdAt, expires_at: expiresAt, revoked_at: null });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("INSERT OR IGNORE INTO paper_events")) {
            const [sid, eventId, eventType, payloadJson, createdAt] = args;
            if (!db.events.some(e => e.session_id === sid && e.event_id === eventId)) {
              db.events.push({ seq: db.seq++, session_id: sid, event_id: eventId, event_type: eventType, payload_json: payloadJson, created_at: createdAt });
            }
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error("Unexpected run SQL: " + sql);
        },
        async first() {
          if (sql.includes("SELECT session_id, expires_at, revoked_at")) return db.sessions.get(args[0]) || null;
          if (sql.includes("SELECT COUNT(*) AS count")) return { count: db.events.filter(e => e.session_id === args[0]).length };
          if (sql.includes("SELECT seq, event_id, event_type, created_at FROM paper_events")) {
            return db.events.find(e => e.session_id === args[0] && e.event_id === args[1]) || null;
          }
          throw new Error("Unexpected first SQL: " + sql);
        },
        async all() {
          if (sql.includes("SELECT seq, event_id, event_type, payload_json, created_at FROM paper_events")) {
            const [sid, after, limit] = args;
            return { results: db.events.filter(e => e.session_id === sid && e.seq > after).sort((a,b)=>a.seq-b.seq).slice(0,limit) };
          }
          throw new Error("Unexpected all SQL: " + sql);
        }
      };
    }};
  }
}
const env = () => ({ PAPER_DB: new FakeD1(), PAPER_LEDGER_SECRET: "test-secret-with-at-least-thirty-two-characters" });
const cookieFrom = response => response.headers.get("set-cookie").split(";")[0];
const request = (url, method, cookie, body, origin = "https://nr.example") => new Request(url, {
  method,
  headers: {
    ...(cookie ? { cookie } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(origin ? { origin } : {})
  },
  ...(body ? { body: JSON.stringify(body) } : {})
});

test("paper session creates an HttpOnly Secure SameSite cookie and reuses it", async () => {
  const e = env();
  const first = await handlePaperSession(request("https://nr.example/api/paper/session", "POST"), e);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie"), /HttpOnly/);
  assert.match(first.headers.get("set-cookie"), /Secure/);
  assert.match(first.headers.get("set-cookie"), /SameSite=Strict/);
  const cookie = cookieFrom(first);
  const second = await handlePaperSession(request("https://nr.example/api/paper/session", "POST", cookie), e);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).session, "active");
  assert.equal(e.PAPER_DB.sessions.size, 1);
});

test("append-only ledger stores events, pages them, and is idempotent", async () => {
  const e = env();
  const session = await handlePaperSession(request("https://nr.example/api/paper/session", "POST"), e);
  const cookie = cookieFrom(session);
  const event = { eventId: "order-event-0001", eventType: "paper.account.snapshot", payload: { account: { cash: 9000 } } };
  const first = await handlePaperLedger(request("https://nr.example/api/paper/ledger", "POST", cookie, event), e);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).accepted.length, 1);
  const duplicate = await handlePaperLedger(request("https://nr.example/api/paper/ledger", "POST", cookie, event), e);
  assert.equal((await duplicate.json()).accepted.length, 1);
  assert.equal(e.PAPER_DB.events.length, 1);
  const read = await handlePaperLedger(request("https://nr.example/api/paper/ledger?after=0&limit=10", "GET", cookie), e);
  const data = await read.json();
  assert.equal(data.events.length, 1);
  assert.deepEqual(data.events[0].payload, { account: { cash: 9000 } });
  assert.equal(data.nextAfter, 1);
});

test("rejects cross-origin writes, unsupported events, and oversized payloads", async () => {
  const e = env();
  const session = await handlePaperSession(request("https://nr.example/api/paper/session", "POST"), e);
  const cookie = cookieFrom(session);
  const cross = await handlePaperLedger(request("https://nr.example/api/paper/ledger", "POST", cookie, { eventId: "event-0000001", eventType: "paper.account.reset" }, "https://evil.example"), e);
  assert.equal(cross.status, 403);
  const invalid = await handlePaperLedger(request("https://nr.example/api/paper/ledger", "POST", cookie, { eventId: "event-0000002", eventType: "paper.live.order", payload: {} }), e);
  assert.equal(invalid.status, 400);
  const huge = await handlePaperLedger(request("https://nr.example/api/paper/ledger", "POST", cookie, { eventId: "event-0000003", eventType: "paper.account.snapshot", payload: { data: "x".repeat(151000) } }), e);
  assert.equal(huge.status, 413);
  assert.equal(e.PAPER_DB.events.length, 0);
});

test("requires D1 and a strong server-side signing secret", async () => {
  const noDb = await handlePaperSession(request("https://nr.example/api/paper/session", "POST"), {});
  assert.equal(noDb.status, 503);
  const weak = await handlePaperSession(request("https://nr.example/api/paper/session", "POST"), { PAPER_DB: new FakeD1(), PAPER_LEDGER_SECRET: "short" });
  assert.equal(weak.status, 503);
});

test("rejects missing, invalid, and expired session cookies", async () => {
  const e = env();
  const noCookie = await handlePaperLedger(request("https://nr.example/api/paper/ledger", "GET"), e);
  assert.equal(noCookie.status, 401);
  const badCookie = await handlePaperLedger(request("https://nr.example/api/paper/ledger", "GET", "nr_paper_session=not-a-token"), e);
  assert.equal(badCookie.status, 401);
});
