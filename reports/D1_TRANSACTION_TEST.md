# D1 事务 / 回滚 / 幂等测试（T02）

- 执行器：`scripts/d1-verify.mjs`（授权后运行）
- 当前状态：🟡 **测试已准备，待 Cloudflare 授权执行**

## 场景 1：batch 回滚语义

**目的**：验证 D1 单条 `execute` 多语句在失败时整体回滚（D1 无交互式事务，原子性靠 `batch` / 单命令多语句）。

**步骤**：
1. 建临时表 `_d1_probe(id PK, v TEXT NOT NULL)`。
2. 执行批：`INSERT (1,'a'); INSERT (2, NULL)` —— 第二条违反 NOT NULL。
3. 查 `COUNT(*)`。

**验收**：批整体回滚，表行数 = 0，无部分写入。

**对应引擎保证**：`paper-server.mjs` 的 `commitState` 使用 `env.DB.batch([...])` 一次性原子写入账户 + 事件；任一语句失败则整批不生效。

## 场景 2：幂等键（重复订单 / 重复请求）

**目的**：同一 `client_order_id` 重复提交只生效一次。

**步骤**：
1. 临时表 `_idem(session, cid, UNIQUE(session,cid))`。
2. 插入 `('s1','c1')` → 成功。
3. 再次插入 `('s1','c1')` → 应失败。
4. 查行数。

**验收**：首次成功、重复失败、行数 = 1。

**对应引擎保证**：`paper_orders` 有 `UNIQUE(session_id, client_order_id)`；重复请求命中唯一约束返回既有确认（`confirmation_id`），不产生第二笔订单。

## 场景 3：金额定点精度（D1 落库）

**目的**：验证定点 INTGER 列回读后与引擎定点一致、无漂移。

**步骤**：插入已知金额（如 `0.1`、`10000.01`），回读 `INTEGER / 1e8` 比对。

**验收**：差值 = 0（1e8 网格内）。

## 当前结果

> BLOCKED: AUTH REQUIRED —— 授权后由 `node scripts/d1-verify.mjs` 填充真实结果到 `reports/D1_VERIFY_RESULT.md`。
