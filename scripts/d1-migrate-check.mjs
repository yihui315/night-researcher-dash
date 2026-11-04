// scripts/d1-migrate-check.mjs — 迁移版本检查（P0-3）
//
// 本地迁移文件数 vs 远程已应用迁移数。用于部署前/后的版本一致性校验。
// 远程查询走 wrangler（需要 Cloudflare 凭据与网络）；离线时仅报告本地数量。

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const migrationsDir = join(root, "migrations");

function localMigrationCount() {
  if (!existsSync(migrationsDir)) return { ok: false, count: 0, error: "migrations/ 目录不存在" };
  const files = readdirSync(migrationsDir)
    .filter((f) => /^(\d{4}_.*\.sql)$/.test(f))
    .sort();
  return { ok: true, count: files.length, files };
}

function remoteAppliedCount() {
  // wrangler d1 migrations list <db> --remote 解析 "No migrations to apply" 或列出已应用迁移
  const dbName = process.env.PAPER_DB_NAME || "paper_test";
  const r = spawnSync(
    "node",
    ["node_modules/wrangler/bin/wrangler.js", "d1", "migrations", "list", dbName, "--remote"],
    { cwd: root, encoding: "utf8", timeout: 60000 },
  );
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || "").trim().slice(0, 200) };
  }
  const out = r.stdout || "";
  if (/No migrations to apply/i.test(out)) return { ok: true, applied: 0, raw: out.trim() };
  // 粗略统计 "applied" 行
  const applied = (out.match(/applied/gi) || []).length;
  return { ok: true, applied, raw: out.trim() };
}

const local = localMigrationCount();
console.log(`本地迁移文件: ${local.ok ? local.count : "N/A"}`);
if (local.ok) console.log("  " + local.files.join("\n  "));

const remote = remoteAppliedCount();
if (remote.ok) {
  console.log(`远程已应用迁移: ${remote.applied}`);
  if (local.ok && remote.applied > local.count) {
    console.error("⚠️ 远程迁移数多于本地：可能缺少迁移文件，禁止部署。");
    process.exit(2);
  }
  if (local.ok && remote.applied < local.count) {
    console.log("ℹ️ 本地有未应用的迁移，部署前应执行 d1:migrate。");
  }
} else {
  console.log(`远程检查跳过（离线/无凭据）: ${remote.error}`);
}
console.log("migration check 完成。");
