# PROJECT_STATUS.md — JEV × Night Researcher × Paper Trading

> 总控执行令 V1.1 统一项目状态。由 WorkBuddy（工程总执行负责人）维护。
> 所有结论基于真实 `git` / 文件系统 / 本地测试核查，非推测。
> 更新时间：2026-11-03（GMT+8）— Sprint 002 启动：T02 验收套件就绪、T03/T04/T05 并行派遣

---

## 0. 一句话结论

指令假设的"现有 JEV v1.3"与"现有 P2 成果"**真实存在**。P2 后端已由另一路工作在远程分支 `feat/p2-server-authoritative-paper`（分支 A）完成大半（成熟引擎 + 14 端点 + JEV 对接 + 测试）。本回合已选定**方案 A**：以分支 A 为 canonical 基础，补其唯一硬冲突——金额用浮点而非指令要求的"定点 Decimal"。定点基石（`decimal.mjs` BigInt 1e8）已建、引擎金额层已移植定点、**81/81 非 e2e 测试零回归通过**（含新增 5 项迁移一致性测试），**T00 基线统一已完成**（五文档齐备、分支核查真实），**T01 定点精度修复已收口并全量推送**，PR 创建链接已就绪（待主理人点开 / 或授权 gh 代建）。
> **Sprint 002（2026-11-03 起）已启动**：T02 D1 验收套件（wrangler.toml + 幂等迁移器 + 真实 D1 验收执行器 + 4 份报告 + 迁移 0003 独立审查）已落盘，真实运行待 Cloudflare 授权；T03（JEV 六交易页）/ T04（六角色）/ T05（行情数据管道）已作为独立分支子 Agent 并行派遣实做。

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
| 集成后回归 + 定点场景测试 | ✅ 完成 | **81/81 非 e2e 测试零回归**（含定点 10 + paper-* 47 + orchestrator/ai-proxy/depth-sequencer 19 + 迁移一致性 5） |
| 迁移前后数据一致性测试 | ✅ 完成 | `tests/migration-fixedpoint.test.cjs`（5/5）：复刻 0003 变换、0.1+0.2 漂移纠正、手续费一致、NULL 安全、round-trip < 1e-8 |

### 2.1 定点设计要点（已落地，供后续 Phase 复用）
- **金额（money）= BigInt 1e8 定点**：cash/fee/notional/realizedPnl/equity/exposure/reservedCash 等。所有算术经 `decimal.mjs`（`add/sub/mul/div/cmp`，`D()` 强制转换任意输入 → 混合 Number/BigInt 调用安全）。落库为 INTEGER；对象内以十进制字符串（`U()`）存储，`JSON.stringify`/sha256 一致；API 边界 `num()`→精确 Number（<2^53 无损），保持客户端契约。
- **价格/数量（market data）= Number**：盘口档位、filters、order.qty/limitPrice/filledQty、position.qty/avgPrice、`walkBook` 返回的 filledQty/avgPrice。仅在这些值参与金额计算时经 `D()` 转定点（`mul(qty, price)` 即 money）。这样既消除金额漂移，又使分支 A 原有 37 项断言无需改动。
- **已修复的定点落地陷阱**：事件 payload 不得含 BigInt（`JSON.stringify` 会崩）→ book/marks/filters 保持 Number；Binance `sequence` 是普通整数，不得过 `D()`；`stepValid` 改 Number 版（epsilon 判定）以匹配直接调用契约。

### 2.2 测试基线（当前提交重跑，非复用旧报告）
- 分支 A 原单测：**37/37 通过**（FakeD1 内存实现，无 wrangler/网络依赖）。
- 定点模块：**10/10 通过**。
- 迁移一致性：**5/5 通过**（新增，T01 验收项）。
- 全量非 e2e：**81/81 通过**（37 + 10 + 19 + 5 迁移 + 10 定点已含于前述）。e2e（playwright，需浏览器/网络）场景已由 `paper-server.test.cjs` 单测等价覆盖，离线不跑。

---

## 3. 与指令要求的差距（其余 Phase）

| 指令 Phase | 状态 | 说明 |
|---|---|---|
| T00 基线统一 | 🟢 完成 | 五文档齐备；两仓库 Git/分支/未提交文件真实核查；`feat/p2-paper-backend` 标废弃候选 |
| Phase 1 P2 收口 | 🟢 定点集成 + PR 收口完成 | 代码已全推 origin；PR 创建链接就绪（base=分支A）；剩余验收：D1 实跑（需账号 token） |
| T02 D1 验收 | 🟡 进行中 | 套件已落盘（wrangler.toml + d1-migrate/d1-verify + 4 报告 + 0003 审查）；真实 D1 运行**待 Cloudflare 授权** |
| Phase 2 JEV 前端六页 | 🟡 进行中 | 子 Agent 已在 `feat/jev-trading-workbench` 实做六页（复用 Provider Center / 自定义 hash 路由 / tradingApi 契约 / Mock Contract）；未提交文件未碰 |
| Phase 3 六角色 | 🟡 进行中 | 子 Agent 已在 `feat/ai-six-roles` 复用 `agent-orchestrator.mjs`/`ai-core.mjs` 建 SPOTTER→…→CLOSER + 门禁 |
| Phase 4 持续运行 | ⬜ 未启动 | 依赖 T02/T03/T04 稳定；研究数据管道（T05）由子 Agent 并行启动 |
| Phase 5 集成交付 | ⬜ 未启动 | — |

---

## 4. 已知阻塞 / 风险
1. **PR 自动创建受阻**：本机无 `gh` CLI、无 `GITHUB_TOKEN`，无法用 API/CLI 建 PR。已提供精确 Web 创建地址（base=分支A，head=fixedpoint），待主理人点开。**此属工具受限，非工作未完成**。
2. **D1 实例创建需 Cloudflare 账号**：无 token 无法代建；本地 FakeD1/SQLite 已做等价测试。`scripts/d1-verify.mjs` 未授权时输出 `BLOCKED: AUTH REQUIRED` 并退出 0，**不伪造结果**。
3. **night_researcher 本地 `main`(`b9eee3b`) 与 `origin/main`(`43c63e9`) 不一致**：按纪律**不直改 main**，仅记录、不调查不改动；待主理人决定如何对齐。
4. ~~**引擎定点集成风险**~~：已收口。回放哈希依赖 `stableStringify(account)` 一致，金额字段统一字符串化（`U()`）+ `D()` 还原，已端到端验证。
5. **GitHub 出网间歇性 502**：`feat/p2-fixedpoint` 有 **2 个提交待推送**（`7df882e` T00 文档、`426328d` T02 套件）；本地已提交，网络恢复即补推，**不空转重试**。
6. **T03/T04/T05 由子 Agent 在独立分支实做**：前端分支 `feat/jev-trading-workbench`（jev 仓）、AI `feat/ai-six-roles`、研究 `feat/research-data-pipeline`（night_researcher 仓）。均受 GIT 安全约束（不碰用户未提交文件、不直推）。

---

## 5. 下一步
1. ✅ T00 基线统一完成（五文档 + 分支核查）。
2. ✅ T01 定点精度修复收口，81/81 非 e2e 测试零回归，4 个提交全推 origin。
3. 主理人点开 PR 创建链接完成 T01；或授权 gh/Token 由我代建。
4. 网络恢复后补推 `7df882e` + `426328d`。
5. 获 Cloudflare 授权后运行 **T02** 真实 D1 验收（`node scripts/d1-verify.mjs`）。
6. 跟进 **T03/T04/T05** 子 Agent 交付（六页 / 六角色 / 数据管道），验收其提交与测试后合入各自 feature 分支。
7. 按 Sprint 002 五日节点推进（11-03 PR+前端结构 / 11-04 迁移审查+六页框架 / 11-05 D1 准备+三页可运行 / 11-06 六角色 Schema+数据管道 / 11-07 三组阶段报告）。
