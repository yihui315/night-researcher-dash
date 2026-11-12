# 迁移 0003 定点化审查报告（B02）

- 审查对象：`migrations/0003_fixed_point.sql`
- 基础分支：`feat/p2-server-authoritative-paper`
- 修复分支：`feat/p2-fixedpoint`
- 审查日期：2026-11-03
- 审查人：WorkBuddy 后端专家（独立核查，非自证）

## 0. 结论速览

| 审查项 | 结论 | 风险 |
|---|---|---|
| REAL→INTEGER 精度 | ✅ 正确（半进位，与 `decimal.mjs` 一致） | 低 |
| 旧数据转换 | ✅ 正确，且能**纠正**历史浮点漂移 | 低 |
| NULL 安全 | ✅ 全部可空列用 `CASE WHEN … IS NULL THEN NULL` | 无 |
| 迁移重复执行风险 | ⚠️ **存在**（裸 `execute --file` 二次执行会报“表不存在”） | 中（有缓解） |
| 历史事件回放兼容性 | ✅ **不受影响**（state_json 未被触碰） | 无 |
| 覆盖完整性 | ✅ orders + fills 全部金额/数量 REAL 列；accounts 无独立金额列 | 无 |

---

## 1. REAL → INTEGER 精度

转换公式：`CAST(ROUND(x * 100000000) AS INTEGER)`。

- 缩放因子 `1e8` 与引擎定点层 `decimal.mjs` 的 `SCALE = 10n ** 8n` **完全一致**。
- SQLite `ROUND` 语义为**远离零的半进位**（half-away-from-zero）：`ROUND(2.5)=3`、`ROUND(-2.5)=-3`。这与 `decimal.mjs` 的 `_roundDiv` 半向上舍入**一致**，故迁移结果与引擎内部定点 BigInt 口径对齐。
- 边界：双精度在 `±9.007e15` 内整数无损；交易金额（< 1e6）乘以 1e8 后远在范围内，无精度损失。
- 反例验证（已在 `tests/migration-fixedpoint.test.cjs` 覆盖）：旧浮点 `0.1 + 0.2 = 0.30000000000000004`，迁移后 `ROUND(0.30000000000000004 * 1e8) = 30000000` → 精确 `0.30000000`，**漂移被纠正**。

## 2. 旧数据转换（已存在 D1 上的 REAL 值）

- 对已在生产/测试 D1 跑过 0002 的数据库，0003 按 `x * 1e8` 缩放旧浮点值；对新部署（按 0001→0002→0003 顺序）也收敛到 INTEGER。两种路径都安全。
- **关键正效应**：旧浮点累积误差（如手续费 `0.0000000001` 级漂移）在迁移时被 `ROUND` 截断到 1e8 网格，等价于“修复”历史脏数据，而非继承漂移。

## 3. NULL 安全

所有可空金额列均用 `CASE WHEN <col> IS NULL THEN NULL ELSE CAST(ROUND(<col> * 1e8) AS INTEGER) END` 处理：
- `paper_orders.limit_price`、`paper_orders.average_fill_price`、`paper_orders.realized_pnl`
- `paper_fills.realized_pnl`

`NOT NULL` 列（quantity/fee 等）无 NULL，无需分支。✅

## 4. 迁移重复执行风险 ⚠️（B02 重点）

**问题**：0003 采用 `CREATE TABLE …_fp → INSERT INTO …_fp SELECT FROM paper_orders → DROP paper_orders → ALTER …_fp RENAME TO paper_orders` 模式。

- 首次执行：正常完成，`paper_orders` 被替换为 INTEGER 版。
- 若用 `wrangler d1 execute --file=0003_fixed_point.sql` **再次直接执行**：此时 `paper_orders` 已是被重命名后的 INTEGER 表，`paper_orders_fp` 已被创建过（`IF NOT EXISTS` 跳过），而 `INSERT … SELECT FROM paper_orders` 中的 `paper_orders` 已不存在 → 报 `no such table: paper_orders`，**执行失败**（不损坏数据，但报错中断）。

**缓解方案（二选一，已在 `scripts/d1-migrate.mjs` 落地）**：

1. **首选**：通过 `wrangler d1 migrations apply` 部署。`wrangler` 在 D1 的 `_migrations` 表中记录已应用的迁移文件，**不会重复执行**同一 `.sql`，从机制上消除该风险。
2. **兜底**：`scripts/d1-migrate.mjs` 在应用 0003 前先 `PRAGMA table_info(paper_orders)`，检查 `quantity` 列 `type` 是否已是 `INTEGER`；若已是定点表则**跳过** 0003，避免二次执行报错。

> 建议：**始终通过 `npm run d1:migrate`（`scripts/d1-migrate.mjs`）或 `wrangler d1 migrations apply` 部署，禁止裸 `execute --file` 重跑 0003。**

## 5. 历史事件回放兼容性 ✅（B02 重点）

- 权威账户状态存于 `paper_accounts.state_json`（JSON 文本），金额以字符串存于其中；`commitState` 以 `state_json` 重算 `state_hash = sha256(account)` 并写入 `paper_server_events.previousStateHash / stateHash` 形成哈希链。
- 0003 **只重建 `paper_orders` / `paper_fills` 两张审计表**，对 `paper_accounts.state_json` **零字节改动**。
- 引擎重算状态与哈希完全依赖 `state_json`，不依赖 orders/fills 的 INTEGER 列（后者仅作审计/查询）。
- 因此：**迁移前后回放哈希链逐事件一致**，已有的事件回放测试（`paper-server.test.cjs` 回放用例）无需改动且仍通过。

## 6. 覆盖完整性

- `paper_orders`：quantity / filled_quantity / remaining_quantity / limit_price / average_fill_price / fee / realized_pnl / reserved_cash / reserved_quantity —— 全部 REAL → INTEGER。✅
- `paper_fills`：quantity / price / notional / fee / realized_pnl —— 全部 REAL → INTEGER。✅
- `paper_accounts`：**无独立 REAL 金额列**（金额在 `state_json` 内），无需迁移。✅
- 其余表（sessions / snapshots / risk_events / strategy_runs 等）由分支 A schema（0002 及更早）覆盖，无金额 REAL 列。✅

## 7. 复跑证据

- `tests/migration-fixedpoint.test.cjs`（5 用例）已随 0003 一致性审查补入，复刻 `CAST(ROUND(x*1e8))` 变换并断言与引擎定点层同尺度一致。
- 全量非 e2e：**81/81**（2026-11-03 重跑，`reports/TEST_LOG_81_2026-11-03.md`）。
