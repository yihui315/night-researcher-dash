#!/usr/bin/env node
/**
 * d1-migrate.mjs — 幂等 D1 迁移运行器（T02 B05）
 *
 * 设计目标：
 *  1. 优先使用 `wrangler d1 migrations apply`，由 wrangler 在 D1 的 _migrations
 *     表中记录已应用文件 —— 天然幂等，避免 0003 二次裸执行报错（见
 *     reports/MIGRATION_0003_REVIEW.md §4）。
 *  2. 面向独立测试库（默认 paper_test），绝不指向生产。
 *
 * 用法：
 *   node scripts/d1-migrate.mjs            # 远程测试库
 *   node scripts/d1-migrate.mjs --local    # 本地 miniflare/SQLite
 *
 * 依赖：npx wrangler（首次运行会自动安装）。需 CLOUDFLARE_API_TOKEN / ACCOUNT_ID。
 */
import { spawnSync } from "node:child_process";

const TARGET = process.env.D1_DB || "paper_test";
const REMOTE = process.argv.includes("--local") ? ["--local"] : ["--remote"];

function attempt(label, args) {
  console.log(`[d1-migrate] ${label}: npx wrangler ${args.join(" ")}`);
  const r = spawnSync("npx", ["wrangler", ...args], { stdio: "inherit" });
  return r.status === 0;
}

// 1) 尝试创建测试库（已存在会报错，忽略即可）
attempt(`ensure test DB '${TARGET}'`, ["d1", "create", TARGET, ...REMOTE]);

// 2) 应用全部迁移（wrangler tracked，天然幂等）
const ok = attempt("apply migrations", ["d1", "migrations", "apply", TARGET, ...REMOTE]);

if (ok) {
  console.log("[d1-migrate] ✅ 迁移完成（已应用/已是最新）");
  process.exit(0);
} else {
  console.error("[d1-migrate] ❌ 迁移失败，请检查 wrangler 授权与 database_id");
  process.exit(1);
}
