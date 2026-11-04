// scripts/pages-deploy.mjs — Pages 部署 + 冒烟测试 + 失败自动停止发布（P0-3）
//
// 流程：
//   1. 构建（npm run build → dist/）
//   2. 迁移版本检查（d1:migrate:check）
//   3. 部署（wrangler pages deploy dist --project-name night-researcher-dash）
//   4. 部署后冒烟测试：若提供 --url，则请求 /api/paper/health，要求 200 且 database.status=ok
//   任意一步失败 → 立即非零退出（不继续、不回滚到生产），即「部署失败自动停止发布」。
//
// 注意：本脚本只负责「部署动作」，不自动合并生产分支、不写入生产库、不发布到外部。
// 生产发布仍属审批闸，由人工确认。

import { spawnSync } from "node:child_process";

const root = process.cwd();
const projectName = process.env.PAGES_PROJECT || "night-researcher-dash";
const args = process.argv.slice(2);
const url = (() => {
  const i = args.indexOf("--url");
  return i >= 0 ? args[i + 1] : null;
}) || process.env.DEPLOY_URL;

function run(label, cmd, cmdArgs, { allowFail = false } = {}) {
  console.log(`\n[deploy] ${label} :: ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", timeout: 300000 });
  if (r.status !== 0 && !allowFail) {
    console.error(`\n❌ ${label} 失败（exit ${r.status}）。已自动停止发布，未上线。`);
    process.exit(r.status === null ? 1 : r.status);
  }
  return r;
}

// 1. 构建
run("构建", "npm", ["run", "build"]);

// 2. 迁移版本检查（允许离线跳过，但非零退出会阻断）
run("迁移检查", "npm", ["run", "d1:migrate:check"], { allowFail: true });

// 3. 部署
run("部署", "node", [
  "node_modules/wrangler/bin/wrangler.js",
  "pages",
  "deploy",
  "dist",
  "--project-name",
  projectName,
]);

// 4. 冒烟测试
if (url) {
  const healthUrl = url.replace(/\/$/, "") + "/api/paper/health";
  console.log(`\n[deploy] 冒烟测试: ${healthUrl}`);
  try {
    const res = spawnSync("node", ["-e",
      `fetch(${JSON.stringify(healthUrl)}).then(r=>r.json().then(j=>({status:r.status,db:(j&&j.database&&j.database.status)||'n/a'}))).then(o=>{console.log('health',JSON.stringify(o));process.exit(o.status===200&&o.db==='ok'?0:1)}).catch(e=>{console.error('health fetch failed',e.message);process.exit(1)})`
    ], { cwd: root, stdio: "inherit", timeout: 30000 });
    if (res.status !== 0) {
      console.error("\n❌ 冒烟测试未通过（health 非 200 或 database 非 ok）。已自动停止发布。");
      process.exit(1);
    }
    console.log("✅ 冒烟测试通过。");
  } catch (e) {
    console.error("\n❌ 冒烟测试异常：", e.message);
    process.exit(1);
  }
} else {
  console.log("\n[deploy] 未提供 --url，跳过冒烟测试（请在获得部署 URL 后手动验证 /api/paper/health）。");
}

console.log("\n✅ 部署流程完成（仍需人工在 Cloudflare 控制台确认并触发生产发布审批）。");
