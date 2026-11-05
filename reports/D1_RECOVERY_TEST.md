# D1 服务重启 / 恢复 / 回放测试（T02）

- 执行器：`scripts/d1-verify.mjs`（授权后运行）
- 当前状态：🟡 **DB 级回放校验已准备；API 级恢复测试待部署**

## 场景 1：事件回放哈希链完整性（DB 级，可立即执行）

**目的**：验证 `paper_server_events` 的哈希链在真实 D1 上未被破坏，重启/迁移后仍可逐事件重放。

**步骤**（`d1-verify.mjs` 自动执行）：
1. 读取 `paper_server_events` 按时间排序。
2. 对每行：`expectedHash = sha256(state_json)`；断言 `state_hash == expectedHash`。
3. 断言 `previous_state_hash == 上一行 state_hash`（链连续）。

**验收**：全部事件链完整、哈希一致。

**意义**：引擎 `commitState` 以 `state_json` 重算哈希，迁移 0003 不触碰 `state_json` → 链在迁移前后一致（见 `MIGRATION_0003_REVIEW.md` §5）。

## 场景 2：服务重启后状态恢复（需部署 worker）

**目的**：worker 重启 / 新实例启动后，从 D1 `paper_accounts.state_json` 恢复权威账户，不丢单、不重置。

**方法**：
1. 写入若干订单/成交；
2. 重启 worker（或冷启动新实例）；
3. 读取账户，断言 `version` / `equity` / `positions` 与重启前一致；
4. 断言事件表最后一条 `state_hash` 与重启后首读匹配。

**验收**：状态零丢失、版本连续、哈希链延续。

## 场景 3：API 鉴权 / 跨账户拒绝（需部署 worker）

**目的**：无 cookie / 伪造 cookie / 跨账户 cookie 均被拒绝。

**方法**：用 `paper-ledger.mjs` 的 HMAC 校验逻辑做集成断言（详见 `functions/_lib/paper-ledger.mjs`）。

**验收**：未授权 401、跨账户 403。

## 当前结果

> BLOCKED: AUTH REQUIRED（DB 级回放校验将在授权后由 `node scripts/d1-verify.mjs` 自动填充到 `reports/D1_VERIFY_RESULT.md`）。API 级场景在 Phase 5 集成验收完成。
