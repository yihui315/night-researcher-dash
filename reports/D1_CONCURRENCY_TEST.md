# D1 并发 / 账户隔离测试（T02）

- 执行器：`scripts/d1-verify.mjs`（授权后运行）
- 当前状态：🟡 **测试已准备，待 Cloudflare 授权执行**

## 场景 1：并发争抢同一账户（乐观锁）

**目的**：两个并发写入同一账户，仅一个成功（version 守卫）。

**步骤**：
1. 临时表 `_lock(id PK, version, val)`，种子 `(1, 1, 0)`。
2. 并发执行 `UPDATE _lock SET val=val+1, version=version+1 WHERE id=1 AND version=1` 两次。
3. 查 `val` / `version`。

**验收**：仅一次成功，`val = 1`，`version = 2`。

**对应引擎保证**：`commitState` 使用 `UPDATE paper_accounts SET … WHERE session_id=? AND version=?`；version 不匹配则该批 `changes !== 1` → 返回 `committed:false`，由调用方重试（API 层重试或返回冲突）。这是服务端权威账户并发安全的核心。

## 场景 2：账户隔离 / 跨账户访问拒绝

**目的**：查询严格按 `session_id` 隔离；一个会话不能读写另一会话的订单/持仓/账本。

**步骤**：
1. 临时表 `_acct(session, bal)`，插入 `('s1',100),('s2',200)`。
2. `SELECT SUM(bal) WHERE session='s1'`。

**验收**：返回 100，不泄露 s2 数据。

**对应引擎保证**：所有读写均以 `session_id` 为作用域；API 鉴权（`paper-ledger.mjs` HMAC 会话 cookie + 同源校验）确保请求只能访问自身会话；跨账户访问在鉴权层拒绝。

## 场景 3：API 层并发（需部署 worker）

**目的**：真实并发订单 POST 到 Paper API，验证服务端串行化。

**方法**（授权+部署后）：以并发脚本对 `POST /api/v1/trading/paper/orders` 发相同/不同 `client_order_id`，断言：
- 不同订单均成功且余额正确扣减；
- 相同 `client_order_id` 仅一笔成交；
- 无负余额/超卖。

**当前状态**：🟡 依赖部署，列入 Phase 5 集成验收（T06）。

## 当前结果

> BLOCKED: AUTH REQUIRED —— 授权后由 `node scripts/d1-verify.mjs` 填充。
