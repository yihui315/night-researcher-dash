// scripts/build.mjs — Pages 构建脚本（P0-3）
//
// 当前前端为原生 HTML + 静态 JS（dashboard/），无需打包器。
// 构建 = 将 dashboard/ 原样复制到 dist/（wrangler.toml 的 pages_build_output_dir），
// 并产出 BUILD_MANIFEST.json（含每文件 SHA256）用于部署校验。
// 零额外依赖，仅用 Node 内置模块。

import {
  cpSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const src = join(root, "dashboard");
const dist = join(root, "dist");

if (!statSync(src, { optional: true })?.isDirectory?.()) {
  console.error(`build: 源目录不存在: ${src}`);
  process.exit(1);
}

// 1. 清空并重建 dist
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 2. 递归复制
function copyDir(from, to) {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = join(from, e.name);
    const d = join(to, e.name);
    if (e.isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyDir(s, d);
    } else {
      mkdirSync(dirname(d), { recursive: true });
      cpSync(s, d);
    }
  }
}
copyDir(src, dist);

// 3. 生成 SHA256 清单
const files = [];
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const rel = relative(dist, p).split("\\").join("/");
      const h = createHash("sha256").update(readFileSync(p)).digest("hex");
      files.push({ path: rel, sha256: h });
    }
  }
}
walk(dist);
writeFileSync(
  join(dist, "BUILD_MANIFEST.json"),
  JSON.stringify({ builtAt: new Date().toISOString(), fileCount: files.length, files }, null, 2),
);

console.log(`build: dashboard -> dist 完成，共 ${files.length} 个文件`);
