# D1 部署与验收说明（T02）

- 负责人：WorkBuddy 后端专家 + QA
- 状态：🟡 **脚本与独立测试库配置已就绪；真实 D1 运行待 Cloudflare 授权**
- 日期：2026-11-03

## 1. 隔离原则（硬约束）

- **绝不指向生产库**。所有验收使用独立测试库 `paper_test`（见 `wrangler.toml`）。
- **不部署生产环境**、**不接真实交易所**、**不使用真实资金**。
- 生产上线需另行评审，并改用独立的 `database_name` / `database_id` 或 `[env.production]` 环境隔离。

## 2. Wrangler 版本锁定

- 通过 `npx wrangler` 调用，首次自动解析 `wrangler` 最新稳定版；如需锁定，在 `package.json` 增加 `devDependencies.wrangler` 固定版本并在 CI 中 `npm ci`。
- 兼容性日期：`compatibility_date = "2024-11-01"`（`wrangler.toml`）。

## 3. 独立测试库创建

```bash
export CLOUDFLARE_API_TOKEN=***   # 仅测试库权限，非生产
export CLOUDFLARE_ACCOUNT_ID=***
npx wrangler d1 create paper_test --remote
# 将返回的 database_id 填入 wrangler.toml 的 database_id
```

## 4. 迁移执行（幂等）

```bash
node scripts/d1-migrate.mjs           # 远程测试库
node scripts/d1-migrate.mjs --local   # 本地 SQLite/miniflare
```

- 内部调用 `wrangler d1 migrations apply`，由 wrangler 在 `_migrations` 表记录已应用文件，**天然幂等**。
- 严禁裸 `wrangler d1 execute --file=0003_fixed_point.sql` 重复执行（见 `MIGRATION_0003_REVIEW.md` §4）。

## 5. 验收测试执行

```bash
node scripts/d1-verify.mjs            # 真实 D1 验收（授权后）
node scripts/d1-verify.mjs --local
```

- 未授权时输出 `BLOCKED: AUTH REQUIRED`，列出已就绪测试，退出 0 —— 不伪造结果。
- 授权后自动执行并将结果写入 `reports/D1_VERIFY_RESULT.md`。
- 逐场景明细见：`D1_TRANSACTION_TEST.md` / `D1_CONCURRENCY_TEST.md` / `D1_RECOVERY_TEST.md`。

## 6. 当前阻塞

| 阻塞 | 影响 | 解决路径 |
|---|---|---|
| 缺 `CLOUDFLARE_API_TOKEN` / `ACCOUNT_ID` | 无法创建/连接真实 D1 | 由主理人提供**仅测试库权限**的 token（不要求生产权限） |
| GitHub 间歇性 502 | 文档提交 `7df882e` 待补推 | 网络恢复即 `git push` |

## 7. 已交付物

- `wrangler.toml` — 测试库 D1 绑定（`DB`）。
- `scripts/d1-migrate.mjs` — 幂等迁移运行器。
- `scripts/d1-verify.mjs` — 真实 D1 验收执行器（回滚/幂等/并发锁/隔离/回放）。
- `migrations/0001..0003.sql` — 全量 schema（含定点化）。
- `reports/MIGRATION_0003_REVIEW.md` — 迁移审查。
- `reports/D1_{TRANSACTION,CONCURRENCY,RECOVERY}_TEST.md` — 验收计划与标准。
