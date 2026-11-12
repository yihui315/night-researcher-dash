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
 *
 * 注：本沙箱 npx 因 genie-trash 清理超时偶发非零退出；以 wrangler/D1 真实返回为准判定成败。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 直接调用本地安装的 wrangler（避免 Windows 下 spawnSync("npx") 无法解析 npx.cmd）。
const __dir = dirname(fileURLToPath(import.meta.url));
const WRANGLER = join(__dir, "..", "node_modules", "wrangler", "bin", "wrangler.js");

const TARGET = process.env.D1_DB || "paper_test";
const REMOTE = process.argv.includes("--local") ? ["--local"] : ["--remote"];

function rawExec(args) {
  const r = spawnSync(process.execPath, [WRANGLER, ...args], { encoding: "utf8" });
  let parsed = null;
  try {
    const idx = (r.stdout || "").search(/[[{]/);
    parsed = idx >= 0 ? JSON.parse(r.stdout.slice(idx)) : null;
  } catch {
    /* 非 JSON 保持 null */
  }
  return { status: r.status, parsed, stderr: r.stderr || "", stdout: r.stdout };
}

/** 执行并判定成败（以 D1 真实返回为准）。 */
function run(label, args) {
  console.log(`[d1-migrate] ${label}`);
  const r = rawExec(args);
  const d1Success =
    Array.isArray(r.parsed) &&
    r.parsed.length > 0 &&
    r.parsed.every((s) => s.success !== false);
  const ok = r.status === 0 || d1Success;
  if (!ok) {
    console.log(r.stderr || r.stdout || "(无输出)");
  }
  return ok;
}

// 1) 创建测试库（已存在会报错，视为成功/幂等）
const created = run(`ensure test DB '${TARGET}'`, ["d1", "create", TARGET]);
if (!created) {
  console.log("[d1-migrate] ⚠️ create 未确认成功（可能已存在或权限不足），继续尝试 apply");
}

// 2) 应用全部迁移（wrangler tracked，天然幂等）
const ok = run("apply migrations", ["d1", "migrations", "apply", TARGET, ...REMOTE]);

if (ok) {
  console.log("[d1-migrate] ✅ 迁移完成（已应用/已是最新）");
  process.exit(0);
} else {
  console.error("[d1-migrate] ❌ 迁移失败，请检查 wrangler 授权与 database_id");
  process.exit(1);
}
