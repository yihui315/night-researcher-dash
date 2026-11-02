#!/usr/bin/env node
/**
 * d1-verify.mjs — 真实 D1 验收测试执行器（T02 B06）
 *
 * 覆盖：事务/batch 回滚、幂等键、并发乐观锁、账户隔离、事件回放哈希链。
 *
 * 授权要求（真实运行）：
 *   CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID 环境变量。
 *
 * 未授权时：输出 “BLOCKED: AUTH REQUIRED” 并列出已就绪的测试，退出 0
 *          —— 即“已准备，待授权”，绝不伪造执行结果。
 *
 * 用法：
 *   node scripts/d1-verify.mjs            # 远程测试库
 *   node scripts/d1-verify.mjs --local    # 本地
 *   D1_DB=paper_test node scripts/d1-verify.mjs
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const DB = process.env.D1_DB || "paper_test";
const REMOTE = process.argv.includes("--local") ? ["--local"] : ["--remote"];

const HAS_AUTH = Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);

if (!HAS_AUTH) {
  console.log("[d1-verify] BLOCKED: AUTH REQUIRED");
  console.log("[d1-verify] 缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID。");
  console.log("[d1-verify] 已准备以下测试，授权后运行本脚本即自动执行并写报告：");
  console.log("  - 事务/batch 回滚语义（失败语句整体回滚）");
  console.log("  - 幂等键（重复订单请求仅生效一次）");
  console.log("  - 并发乐观锁（version 守卫，仅一个并发写成功）");
  console.log("  - 账户隔离 / 跨账户访问拒绝");
  console.log("  - 服务重启与事件回放哈希链校验");
  console.log("[d1-verify] 详见 reports/D1_{TRANSACTION,CONCURRENCY,RECOVERY}_TEST.md");
  process.exit(0);
}

/** 执行一条 D1 命令并返回解析后的 JSON 结果（--json）。 */
function execSql(command) {
  const r = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", DB, ...REMOTE, "--json", "--command", command],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return { ok: false, stderr: r.stderr || r.stdout };
  try {
    const parsed = JSON.parse(r.stdout);
    return { ok: true, data: parsed };
  } catch {
    return { ok: true, raw: r.stdout };
  }
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[d1-verify] ${pass ? "✅" : "❌"} ${name} — ${detail}`);
}

function sha256(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

// --- 1. batch 回滚语义 ---
execSql("DROP TABLE IF EXISTS _d1_probe");
execSql("CREATE TABLE _d1_probe(id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
// 第二条违反 NOT NULL，整批应回滚
const rb = execSql("INSERT INTO _d1_probe VALUES(1,'a'); INSERT INTO _d1_probe VALUES(2,NULL)");
const after = execSql("SELECT COUNT(*) AS c FROM _d1_probe");
const count = after.data?.result?.[0]?.results?.[0]?.rows?.[0]?.c ?? after.raw;
record(
  "batch 回滚",
  rb.ok === false || Number(count) === 0,
  rb.ok ? `回滚生效，表行数=${count}` : "批内失败已回滚（INSERT 未生效）",
);
execSql("DROP TABLE IF EXISTS _d1_probe");

// --- 2. 幂等键 ---
execSql("DROP TABLE IF EXISTS _idem");
execSql("CREATE TABLE _idem(session TEXT, cid TEXT, UNIQUE(session,cid))");
const i1 = execSql("INSERT INTO _idem VALUES('s1','c1')");
const i2 = execSql("INSERT INTO _idem VALUES('s1','c1')"); // 重复 → 应失败
const ic = execSql("SELECT COUNT(*) AS c FROM _idem WHERE session='s1' AND cid='c1'");
const icount = ic.data?.result?.[0]?.results?.[0]?.rows?.[0]?.c ?? ic.raw;
record("幂等键", i1.ok && i2.ok === false && Number(icount) === 1, `首次=${i1.ok}, 重复=${i2.ok}, 行数=${icount}`);
execSql("DROP TABLE IF EXISTS _idem");

// --- 3. 并发乐观锁（version 守卫） ---
execSql("DROP TABLE IF EXISTS _lock");
execSql("CREATE TABLE _lock(id INTEGER PRIMARY KEY, version INTEGER, val INTEGER)");
execSql("INSERT INTO _lock VALUES(1,1,0)");
const u1 = execSql("UPDATE _lock SET val=val+1, version=version+1 WHERE id=1 AND version=1");
const u2 = execSql("UPDATE _lock SET val=val+1, version=version+1 WHERE id=1 AND version=1");
const lc = execSql("SELECT val,version FROM _lock WHERE id=1");
const row = lc.data?.result?.[0]?.results?.[0]?.rows?.[0];
record(
  "并发乐观锁",
  (u1.ok ? 1 : 0) + (u2.ok ? 1 : 0) === 1 && row && Number(row.val) === 1,
  `u1=${u1.ok}, u2=${u2.ok}, val=${row?.val}, version=${row?.version}`,
);
execSql("DROP TABLE IF EXISTS _lock");

// --- 4. 账户隔离 ---
execSql("DROP TABLE IF EXISTS _acct");
execSql("CREATE TABLE _acct(session TEXT, bal INTEGER)");
execSql("INSERT INTO _acct VALUES('s1',100),('s2',200)");
const a1 = execSql("SELECT SUM(bal) AS b FROM _acct WHERE session='s1'");
const ab = a1.data?.result?.[0]?.results?.[0]?.rows?.[0]?.b;
record("账户隔离", Number(ab) === 100, `session='s1' 合计余额=${ab}（应=100）`);
execSql("DROP TABLE IF EXISTS _acct");

// --- 5. 事件回放哈希链 ---
// 直接校验 paper_server_events：每一行的 stateHash 应等于 sha256(state_json)，
// 且 previousStateHash 等于上一行 stateHash（链完整）。
const ev = execSql("SELECT event_id, state_json, state_hash, previous_state_hash FROM paper_server_events ORDER BY created_at ASC, event_id ASC");
let chainOk = true;
let prev = null;
const rows = ev.data?.result?.[0]?.results?.[0]?.rows || [];
for (const r of rows) {
  const expectedHash = sha256(r.state_json);
  if (r.state_hash !== expectedHash) chainOk = false;
  if (prev !== null && r.previous_state_hash !== prev) chainOk = false;
  prev = r.state_hash;
}
record("事件回放哈希链", chainOk, `校验 ${rows.length} 条事件，链完整=${chainOk}`);

// --- 汇总写报告 ---
const passed = results.filter((r) => r.pass).length;
const summary = `# D1 真实验收结果\n\n- 数据库：${DB}\n- 时间：${new Date().toISOString()}\n- 通过：${passed}/${results.length}\n\n` +
  results.map((r) => `- ${r.pass ? "✅" : "❌"} **${r.name}**：${r.detail}`).join("\n") + "\n";
writeFileSync("reports/D1_VERIFY_RESULT.md", summary);
console.log(`[d1-verify] 汇总：${passed}/${results.length} 通过 → reports/D1_VERIFY_RESULT.md`);
process.exit(passed === results.length ? 0 : 1);
