# PROJECT_STATUS.md — JEV × Night Researcher × Paper Trading

> 总控执行令 V1.0 统一项目状态。由 WorkBuddy（工程总执行负责人）维护。
> 所有结论基于真实 `git` / 文件系统 / 本地测试核查，非推测。
> 更新时间：2026-11-02（GMT+8）

---

## 0. 一句话结论

指令假设的"现有 JEV v1.3"与"现有 P2 成果"**真实存在**。P2 后端已由另一路工作在远程分支 `feat/p2-server-authoritative-paper`（分支 A）完成大半（成熟引擎 + 14 端点 + JEV 对接 + 测试）。本回合已选定**方案 A**：以分支 A 为 canonical 基础，补其唯一硬冲突——金额用浮点而非指令要求的"定点 Decimal"。定点基石（`decimal.mjs` BigInt 1e8）已建、引擎金额层已移植定点、**76/76 非 e2e 测试零回归通过**，P1-2 定点精度修复已收口。

---

## 1. 基线审计结果（证据）

| 仓库 / 分支 | 路径 | 状态 | 关键事实 |
|---|---|---|---|
| **Night Researcher** | `D:\数据分析\night_researcher` | 主仓；本回合在 `feat/p2-fixedpoint`（跟踪 `origin/feat/p2-server-authoritative-paper`） | 研究回测 + 静态前端 + Cloudflare Pages |
| **P2 后端（canonical）** | `origin/feat/p2-server-authoritative-paper`（tip `107a6ec`） | 远程，成熟 | `paper-server.mjs`(1035行)+双迁移+14 API+JEV对接+大量测试 |
| **P2 前端+JEV对接** | `origin/feat/paper-trading-command-center`（tip `360d1df`） | 远程 | trading.html/market3d + `integration/jev/tradingApi.mjs` |
| **JEV v1.3** | `D:\jev`（git `release/jcc-v1.3-final`，HEAD `cb35fba`） | 真实 monorepo | `apps/command_center_3d`：**react/react-dom 19.3.0**、@react-three/fiber 9.8.1 + three 0.186.1（Three.js 实锤）、Vite/TS/Vitest/Tailwind/Radix。含 **Provider Center / ProviderRegistry / mission workspace / task composer / project gate** |

### 1.1 关键发现
1. P2 已成熟（分支 A）：服务端权威账户、服务端重拉盘口、确定性逐档 `walkBook` 撮合、限价预留/部分成交、`clientOrderId` 幂等、`version` 乐观锁并发、hash 链接事件回放、HMAC 会话鉴权+同源、风控熔断、fail-closed。其测试名覆盖指令 Phase 5 **12 项门禁全场景**。
2. 我此前在 `feat/p2-paper-backend`（`c9c166d`）从零建的 P2 是**重复建设**，已判定不再推进（其定点层被移植进本分支）。
3. **唯一硬冲突**：分支 A 金额用 `REAL` 浮点 + `toFixed(12)`，违反指令"定点金额计算"。已新建定点模块修复。

### 1.2 工作区
- 本分支 `feat/p2-fixedpoint`：新增 `functions/_lib/decimal.mjs`、`tests/decimal.test.cjs`、`migrations/0003_fixed_point.sql`（均待提交）。
- `feat/p2-paper-backend` 上残留 Phase 0 文档与未推送提交（将被本分支吸收/退役）。
- 未对 `D:\jev` 或任何用户文件执行重置/覆盖。

---

## 2. P1-2 进度（定点精度修复）— ✅ 已收口

| 子任务 | 状态 | 证据 |
|---|---|---|
| 定点 Decimal 模块（`decimal.mjs`, BigInt 1e8） | ✅ 完成 | 10/10 测试通过 |
| 定点模块测试（含浮点缺陷反证） | ✅ 完成 | `tests/decimal.test.cjs` |
| 迁移 0003（REAL→INTEGER 1e8） | ✅ 完成 | `migrations/0003_fixed_point.sql` |
| **引擎集成**（paper-server.mjs 金额层改用定点） | ✅ 完成 | 金额/费用/盈亏/净值/敞口/预留全部定点；price/quantity 保持 Number（市场数据，非累积金额），37 项原断言零改动 |
| 集成后回归 + 定点场景测试 | ✅ 完成 | **76/76 非 e2e 测试零回归**（含定点 10 + paper-* 47 + orchestrator/ai-proxy/depth-sequencer 19） |

### 2.1 定点设计要点（已落地，供后续 Phase 复用）
- **金额（money）= BigInt 1e8 定点**：cash/fee/notional/realizedPnl/equity/exposure/reservedCash 等。所有算术经 `decimal.mjs`（`add/sub/mul/div/cmp`，`D()` 强制转换任意输入 → 混合 Number/BigInt 调用安全）。落库为 INTEGER；对象内以十进制字符串（`U()`）存储，`JSON.stringify`/sha256 一致；API 边界 `num()`→精确 Number（<2^53 无损），保持客户端契约。
- **价格/数量（market data）= Number**：盘口档位、filters、order.qty/limitPrice/filledQty、position.qty/avgPrice、`walkBook` 返回的 filledQty/avgPrice。仅在这些值参与金额计算时经 `D()` 转定点（`mul(qty, price)` 即 money）。这样既消除金额漂移，又使分支 A 原有 37 项断言无需改动。
- **已修复的定点落地陷阱**：事件 payload 不得含 BigInt（`JSON.stringify` 会崩）→ book/marks/filters 保持 Number；Binance `sequence` 是普通整数，不得过 `D()`；`stepValid` 改 Number 版（epsilon 判定）以匹配直接调用契约。

### 2.2 测试基线
- 分支 A 原单测：**37/37 通过**（FakeD1 内存实现，无 wrangler/网络依赖）。
- 定点模块：**10/10 通过**。
- 全量非 e2e：**76/76 通过**（37 + 10 + agent-orchestrator/ai-proxy/depth-sequencer 19）。e2e（playwright，需浏览器/网络）场景已由 `paper-server.test.cjs` 单测等价覆盖，离线不跑。

---

## 3. 与指令要求的差距（其余 Phase）

| 指令 Phase | 状态 | 说明 |
|---|---|---|
| Phase 1 P2 收口 | 🟢 定点集成完成 | 其余能力分支 A 已覆盖；剩余验收：D1 实跑（需账号 token） |
| Phase 2 JEV 前端六页 | ⬜ 未启动 | JEV React 19 / Provider Center / Three.js 已确认可用；待在 `apps/command_center_3d` 内复用 |
| Phase 3 六角色 | ⬜ 部分存在 | 分支 A 有 `agent-orchestrator.mjs`/`ai-core.mjs`；SPOTTER→…→CLOSER 完整链路待建 |
| Phase 4 持续运行 | ⬜ 未启动 | 需稳定后端 + 前端 |
| Phase 5 集成交付 | ⬜ 未启动 | — |

---

## 4. 已知阻塞 / 风险
1. **GitHub 出网波动**：沙箱 `github.com` 间歇性 502/超时；`feat/p2-fixedpoint` 待网络恢复后推送 + 提 PR（不碰 main）。
2. **D1 实例创建需 Cloudflare 账号**：无 token 无法代建；本地 FakeD1/SQLite 可做等价测试。
3. ~~**引擎定点集成风险**~~：已收口。回放哈希依赖 `stableStringify(account)` 一致，金额字段统一字符串化（`U()`）+ `D()` 还原，已端到端验证（事件回放测试 44 通过）。

---

## 5. 下一步
1. ✅ 引擎定点集成完成，76/76 非 e2e 测试零回归。
2. 网络恢复后推送 `feat/p2-fixedpoint` 并提 PR 到 `origin/feat/p2-server-authoritative-paper`（不碰 main）。
3. 启动 Phase 2：确认 JEV Provider Center 接入点，在 `apps/command_center_3d` 内复用建六交易页（市场总览/交易工作台/AI六角色中心/风险管理/策略研究/交易审计）。
4. 视主理人需要补 D1 实跑验收（需 Cloudflare 账号 token）与 e2e playwright 跑测。
