// tests/paper-health.test.mjs — 健康检查离线验收（P0-3）
//
// 验证 /api/paper/health 与 /api/paper/ready 真实探测 D1，而非返回固定 ok。
// 运行：node --test tests/paper-health.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handlePaperHealth,
  handlePaperReady,
  probeDatabase,
  REQUIRED_TABLES,
} from "../functions/_lib/paper-health.mjs";

function makeDb({ fail = false, tables = REQUIRED_TABLES } = {}) {
  return {
    prepare(sql) {
      if (fail) throw new Error("simulated DB failure");
      return {
        bind(..._a) {
          return this;
        },
        async first() {
          if (/SELECT 1/.test(sql)) return { ok: 1 };
          return null;
        },
        async all() {
          if (/sqlite_master/.test(sql)) {
            return { results: tables.map((n) => ({ name: n })) };
          }
          return { results: [] };
        },
      };
    },
  };
}

test("probeDatabase: 健康 D1 返回 ok 且核心表齐全", async () => {
  const r = await probeDatabase({ PAPER_DB: makeDb() });
  assert.equal(r.status, "ok");
  assert.equal(r.coreTablesComplete, true);
  assert.ok(r.latencyMs >= 0);
});

test("probeDatabase: 缺少 PAPER_DB 绑定 → not_configured", async () => {
  const r = await probeDatabase({});
  assert.equal(r.status, "not_configured");
  assert.equal(r.coreTablesComplete, false);
});

test("probeDatabase: D1 抛错 → error（非固定 ok）", async () => {
  const r = await probeDatabase({ PAPER_DB: makeDb({ fail: true }) });
  assert.equal(r.status, "error");
  assert.match(r.detail, /simulated DB failure/);
});

test("probeDatabase: 核心表缺失 → coreTablesComplete=false", async () => {
  const r = await probeDatabase({ PAPER_DB: makeDb({ tables: ["paper_accounts"] }) });
  assert.equal(r.status, "ok"); // SELECT 1 仍成功
  assert.equal(r.coreTablesComplete, false); // 但表不全
});

test("handlePaperHealth: 健康 → 200, database.status=ok", async () => {
  const res = await handlePaperHealth(null, { PAPER_DB: makeDb() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, "ok");
  assert.equal(body.database.status, "ok");
  assert.equal(body.database.coreTablesComplete, true);
  assert.ok(typeof body.timestamp === "string");
});

test("handlePaperHealth: 缺绑定 → 503（区分服务存活与数据库不可用）", async () => {
  const res = await handlePaperHealth(null, {});
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.service, "ok"); // 服务进程存活
  assert.equal(body.database.status, "not_configured"); // 但数据库不可用
});

test("handlePaperReady: 健康 + 密钥配置 → 200 ready=true", async () => {
  const env = { PAPER_DB: makeDb(), PAPER_LEDGER_SECRET: "x".repeat(40) };
  const res = await handlePaperReady(null, env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ready, true);
  assert.equal(body.secretConfigured, true);
});

test("handlePaperReady: 缺少密钥 → 503 ready=false", async () => {
  const env = { PAPER_DB: makeDb(), PAPER_LEDGER_SECRET: "short" };
  const res = await handlePaperReady(null, env);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ready, false);
  assert.equal(body.secretConfigured, false);
});
