# ARCHITECTURE.md — JEV × Night Researcher × Paper Trading

> 系统架构总览。基于真实代码核查（`night_researcher` 分支 A + `feat/p2-fixedpoint`、`jev` v1.3）。
> 更新时间：2026-11-02（GMT+8）。所有结论来自实际文件与测试，非设计空想。

---

## 1. 系统分层

```
┌─────────────────────────────────────────────────────────────┐
│  JEV command_center_3d  (前端, React 19 + R3F + Lightweight) │  Phase 2 待建
│  六交易页: 市场总览/交易台/AI六角色/风险/策略研究/审计         │
│  复用: Provider Center · integration/jev/tradingApi.mjs      │
└───────────────┬─────────────────────────────────────────────┘
                │  HTTPS + HMAC 会话 cookie（同源 CSRF 防护）
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Night Researcher  Cloudflare Pages Functions (API 边界)     │  Phase 1 已收口
│  - paper-ledger.mjs : 会话/HMAC/事件账本/回放                 │
│  - paper-server.mjs : 服务端权威账户/撮合/风控/幂等/回放       │
└───────────────┬─────────────────────────────────────────────┘
                │  D1（SQLite 兼容）批处理 + version 乐观锁
                ▼
┌─────────────────────────────────────────────────────────────┐
│  D1 权威账本（paper_accounts/orders/fills/events/sessions）  │  定点 INTEGER 1e8
└───────────────┬─────────────────────────────────────────────┘
                │  公开行情（只读，不交易）
                ▼
┌─────────────────────────────────────────────────────────────┐
│  行情与数据管道（Phase 5 量化研究）                          │  BTC/ETH/ORDI + 快照ID
│  market_snapshots / strategy_versions / strategy_runs /      │
│  strategy_decisions / oos_results / daily_performance        │
└───────────────┬─────────────────────────────────────────────┘
                │  六角色决策链（复用 agent-orchestrator.mjs / ai-core.mjs）
                ▼
┌─────────────────────────────────────────────────────────────┐
│  AI 六角色：SPOTTER→PRIOR→EDGE→KELLY→TAKER→CLOSER           │  Phase 3 待建
│  TAKER 仅提案 → 用户确认 → 服务端风控 → 撮合                │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 金额精度层（核心契约，已收口）

| 维度 | 类型 | 说明 |
|---|---|---|
| **金额（money）** | `BigInt` 1e8 定点 | cash / fee / notional / realizedPnl / equity / exposure / reservedCash 等 |
| **价格/数量（market data）** | `Number` | 盘口档位、filters、order/position 的 qty/price、`walkBook` 输出 |

- 模块：`functions/_lib/decimal.mjs`（`D()/U()/add/sub/mul/div/cmp/toNumber`，`SCALE=10n**8n`）。
- 算术统一经 `decimal.mjs`；`D()` 强制转换任意输入 → Number/BigInt 混合调用安全。
- 落库：金额列 `INTEGER`（= 实际值 × 1e8）；对象内以十进制字符串（`U()`）存，`JSON.stringify`/sha256 一致。
- API 边界：`num(b)=toNumber(b)` → `Number(U(b))`，转回精确 Number（< 2^53 无损）。
- 迁移：`migrations/0003_fixed_point.sql` 以 `CAST(ROUND(x*1e8) AS INTEGER)` 重建表，旧 REAL 浮点值按 1e8 缩放；全新部署走 0001→0002→0003 也收敛到 INTEGER。
- **权威性原则**：金额权威在服务端 D1，浏览器/前端**永不**作为账户余额权威来源（指令 + 安全纪律双约束）。

---

## 3. 撮合与风控（服务端权威，分支 A + 定点）

- **服务端重拉盘口** `fetchMarketContext`：订单执行时服务端重新取价，不接受客户端报价作为成交依据。
- **确定性逐档撮合** `walkBook`：按盘口档位顺序成交；市价单 IOC，限价单 GTC + 预留/部分成交/撤单。
- **幂等**：`clientOrderId` 唯一约束 + `request_hash` 去重，重复订单返回首次结果。
- **并发**：`version` 乐观锁 + `UPDATE ... WHERE version=?`，并发仅 1 成功，其余回滚重试。
- **事件账本回放**：`paper_server_events` 每快照记 `previousStateHash` + `stateHash=sha256(account)`，回放校验链完整（fail-closed）。
- **风控熔断**：服务端风险检查 fail-closed；余额不足/盘口缺失等直接拒绝。
- **鉴权**：HMAC 会话 cookie + 同源校验；账户隔离（跨账户访问拒绝）。

---

## 4. 六角色决策链（Phase 3，复用现有 Agent 基座）

- 复用文件：`functions/_lib/agent-orchestrator.mjs`、`functions/_lib/ai-core.mjs`（**不另建第二套 Agent 系统**）。
- 门禁：
  - EDGE 无证据 → 不允许晋级；
  - KELLY 样本不足 → 仓位必须为零；
  - OOS 未过 → 禁入正式策略池；
  - TAKER 仅生成 **Paper Order Proposal**，不直接改账户；
  - CLOSER 必须记录退出理由。
- 每次决策链 ID 可全链路追溯（SPOTTER→最终成交/风险拒绝）。

---

## 5. 合规与安全边界（全程）

- ⛔ 不连真实交易所、不使用真实资金、不擅自部署生产。
- ⛔ 浏览器不作为余额权威来源。
- ⛔ 不直改 `main`/`master`；所有改动走 feature 分支 + PR。
- 🔒 HMAC 会话 + 账户隔离 + 风控 fail-closed + 事件回放 fail-closed。

---

## 6. 技术栈（实测，非声明）

| 层 | 技术 | 证据 |
|---|---|---|
| 前端 | React 19.3.0 / @react-three/fiber 9.8.1 / three 0.186.1 | `jev` v1.3 `package.json` |
| 前端工具 | Vite / TS / Vitest / Tailwind / Radix-UI | `jev` v1.3 |
| 后端 | Cloudflare Pages Functions + D1（SQLite 兼容） | `night_researcher` 迁移 + functions |
| 测试 | Node `--test`（FakeD1 内存实现，无 wrangler/网络依赖） | `tests/*.test.cjs` |
| 定点 | BigInt 1e8（自研 `decimal.mjs`） | `functions/_lib/decimal.mjs` |

---

## 7. 当前完成度（截至 2026-11-02）

- ✅ Phase 1 定点精度修复（P1-2）：81/81 非 e2e 测试零回归（76 既有 + 5 迁移一致性）。
- ✅ 分支 A 服务端权威引擎（撮合/风控/幂等/回放/鉴权）由远程分支成熟提供。
- ⬜ Phase 2 前端六页（待启动，确认 Provider Center 接入点）。
- ⬜ Phase 3 六角色完整链路（复用 agent-orchestrator/ai-core）。
- ⬜ Phase 5 量化数据管道（行情采集/OOS/每日绩效）。
- ⬜ T02 D1 实跑验收（需 Cloudflare 账号 token；无则以 FakeD1/SQLite 等价覆盖）。
