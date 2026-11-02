(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.NRPaperLedger = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function eventId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return "evt-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 14);
  }
  function createClient(options) {
    const opts = options || {};
    const fetcher = opts.fetch || fetch.bind(globalThis);
    const base = opts.baseUrl || "";
    let ready = false;
    let unavailable = false;
    let writeQueue = Promise.resolve();
    let lastError = null;

    async function readJson(response) {
      let data = {};
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) {
        const error = new Error(data.error || "模拟账本请求失败（HTTP " + response.status + "）");
        error.status = response.status;
        error.code = data.code || null;
        throw error;
      }
      return data;
    }

    async function startSession() {
      if (ready) return { available: true, reused: true };
      if (unavailable) return { available: false, reason: lastError || "server-ledger-unavailable" };
      try {
        const response = await fetcher(base + "/api/paper/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}",
          cache: "no-store"
        });
        const data = await readJson(response);
        ready = data.ok === true;
        return { available: ready, session: data.session || "active", expiresAt: data.expiresAt || null };
      } catch (error) {
        lastError = error.message;
        if (error.status === 503 || error.status === 404) unavailable = true;
        throw error;
      }
    }

    async function requestLedger(path, init) {
      await startSession();
      if (!ready) return { ok: false, available: false, events: [] };
      const response = await fetcher(base + "/api/paper/ledger" + (path || ""), {
        credentials: "same-origin",
        cache: "no-store",
        ...(init || {})
      });
      return readJson(response);
    }

    function appendEvent(event) {
      const task = writeQueue.then(async () => {
        const result = await requestLedger("", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event)
        });
        return result;
      });
      writeQueue = task.catch(() => {});
      return task;
    }

    function appendSnapshot(account, marks, reason) {
      const snapshot = JSON.parse(JSON.stringify(account || {}));
      snapshot.updatedAt = snapshot.updatedAt || new Date().toISOString();
      return appendEvent({
        eventId: eventId(),
        eventType: "paper.account.snapshot",
        payload: {
          schemaVersion: 1,
          source: "browser-paper-engine",
          reason: String(reason || "state-change").slice(0, 80),
          account: snapshot,
          marks: marks && typeof marks === "object" ? marks : {}
        }
      });
    }

    async function latestSnapshot() {
      const data = await requestLedger("?latest=1&eventType=paper.account.snapshot&limit=1", { method: "GET" });
      const events = Array.isArray(data.events) ? data.events : [];
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.eventType === "paper.account.snapshot" && event.payload && event.payload.account && event.payload.account.version === 1) {
          return { event, account: event.payload.account };
        }
      }
      return null;
    }

    return {
      startSession,
      appendEvent,
      appendSnapshot,
      latestSnapshot,
      getStatus: () => ({ ready, unavailable, lastError })
    };
  }
  return { createClient };
});
