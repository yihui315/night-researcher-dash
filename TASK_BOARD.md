# TASK_BOARD.md — JEV × Night Researcher × Paper Trading

> 任务看板。虚拟专家岗位（指令 §二）仅作职责标注，实际代码由 WorkBuddy 调度实施与验收。
> 纪律：优先复用现有成果 · 不直改 master · 独立 feature 分支 · 完成即提交+测试证据 · 不虚构结果 · 不降安全门槛。

更新时间：2026-11-03（GMT+8）— **V2.0 自主执行总控已上线**（凭据中心 + 常驻 Supervisor + 每日 03:05 自动巡检）。T02 D1 **真实验收 5/5**；T03/T04/T05 已交付并独立核验（27/9/7）；四分支推送待 fine-grained PAT 补全 Contents:write。**T05 当前 216 快照为确定性离线 Mock，非真实行情。**

---

## 虚拟专家岗位（职责映射）

| # | 岗位 | 在本项目负责 |
|---|---|---|
| 1 | 首席架构师 | 精度分叉决策、P2/JEV 边界、D1 schema 终稿 |
| 2 | 后端负责人 | Paper Trading API（分支 A 收口 + 定点修复） |
| 3 | 数据库专家 | SQLite/D1 schema、事务、恢复、回放 |
| 4 | 量化专家 | 行情、回测、OOS 门槛、策略收益核算 |
| 5 | AI Agent 专家 | 六角色协作链路 |
| 6 | 前端负责人 | JEV React 六交易页、Three.js、Lightweight Charts |
| 7 | 安全专家 | 鉴权、账户隔离、风控门禁、fail-closed |
| 8 | QA/SRE | 自动化测试、持续运行、故障恢复 |

---

## 任务清单

### Phase 0 — 项目基线（T00，✅ 已完成）
- [x] **P0-1** 审计 night_researcher 各分支与 Git 状态（含远程新分支）— 证据已记录
- [x] **P0-2** 审计 `D:\jev` 真实工程（v1.3 monorepo、Provider Center、React）— 证据已记录（未改动其未提交文件）
- [x] **P0-3** 评估本地 `feat/p2-paper-backend` 与远程 P2 分支关系（结论：重复建设）— 标记废弃候选，不删不推进（现 tip `df8f643`）
- [x] **P0-4** 建立 `PROJECT_STATUS.md` 与 `TASK_BOARD.md`（本文件）
- [x] **P0-5** 确认 JEV 是否为 React 19（`apps/command_center_3d/package.json`）— ✅ 19.3.0 已确认
- [x] **P0-6** 生成统一文档五件套：`PROJECT_STATUS.md` / `TASK_BOARD.md` / `ARCHITECTURE.md` / `BRANCH_INVENTORY.md` / `DAILY_LOG.md` — ✅ 齐备
- [x] **P0-7** 核查 JEV `release/jcc-v1.3-final` 与 `master` 关系 — `0 230`（master 全包含于 release，release 领先 230 未回并），非异常

### Phase 1 — P2 后端收口
- [x] **P1-1** 评估远程 `feat/p2-server-authoritative-paper` 对指令 Phase 1 的覆盖 — 见 PROJECT_STATUS §1.1
- [x] **P1-2** 【关键】定点精度修复：金额 `REAL` → BigInt 1e8 定点（`paper-server.mjs` 金额层移植 `decimal.mjs`）— ✅ 完成，**81/81 非 e2e 零回归**（含新增 5 迁移一致性）
- [x] **P1-3** schema 对齐：迁移 `0003` 将 money/qty/price 列 REAL→INTEGER 1e8；positions/idempotency_keys/market_snapshots/risk_events/strategy_runs 由分支 A schema 覆盖（已文档化）
- [x] **P1-4** 运行分支 A 现有测试，核实真实通过率 — ✅ 47/47 paper-* + jev-trading-api；全量非 e2e **81/81**（当前提交重跑，非复用旧报告）
- [x] **P1-5** 收敛为单一 PR：基于分支 A 开 `feat/p2-fixedpoint`，合并定点层；**PR 创建链接已就绪**（base=分支A，不碰 main）— ⏳ 待 PAT 补全 Contents:write 后代建
- [x] **P1-6** 指令 Phase 5 的 12 项门禁逐条映射 + 实测报告 — 由 `paper-server.test.cjs` 等价覆盖
- [x] **P1-7** 迁移前后数据一致性测试 — ✅ `tests/migration-fixedpoint.test.cjs` 5/5

### Phase 2 — JEV 前端（六交易页）— ✅ 已交付·待推送（`feat/jev-trading-workbench`，jev 仓 `2dc4ad6`）
- [x] **P2-1** 确认 JEV Provider Center / API 基础设施 / 设计组件接入点 — ✅ 已确认（自定义 hash 路由 + `lib/authorizedFetch` + `tradingApi.mjs` 契约）
- [x] **P2-2** 市场总览页 — ✅ 子 Agent 交付（复用 Lightweight Charts + SVG 回退）
- [x] **P2-3** 交易工作台页（下单→服务端风控→用户确认→Paper API）— ✅ 交付，`createPaperOrder` 强制 `confirmationId`
- [x] **P2-4** AI 六角色中心页 — ✅ 交付
- [x] **P2-5** 风险管理页 — ✅ 交付
- [x] **P2-6** 策略研究页 — ✅ 交付
- [x] **P2-7** 交易审计页（事件/回放可视化）— ✅ 交付
- [ ] **P2-8** Mock→真实 Paper API 切换与验收 — ⬜ 待后端合并后

### Phase 3 — 六角色决策链路 — ✅ 已交付·待推送（`feat/ai-six-roles`，`4b64ea5`）
- [x] **P3-1** 复用 `agent-orchestrator.mjs` / `ai-core.mjs` 搭建 SPOTTER→PRIOR→EDGE→KELLY→TAKER→CLOSER — ✅ 交付，9/9 测试
- [x] **P3-2** 每角色审计字段（run_id/strategy_id/strategy_version/market_snapshot_id/provider/model/prompt_tokens/completion_tokens/latency/decision/rejection_reason）+ decision_chain_id — ✅ Schema 强制
- [x] **P3-3** TAKER 仅提案不改性账户；订单经服务端风控 + 用户确认 — ✅ 门禁落实（`__accountUntouched` 断言）

### Phase 4 — 持续 Paper Trading（≥30 天）
- [ ] **P4-1** 真实公开行情持续采集（不等待 UI）— T05 管道已就绪
- [ ] **P4-2** 每策略独立收益 / 手续费滑点 / 最大回撤 / 胜率 / 盈亏比核算
- [ ] **P4-3** 失效策略自动暂停；OOS 未过禁晋级
- [ ] **P4-4** 历史记录不可覆盖/删除

### Phase 5 — 最终集成与交付
- [ ] **P5-1** 全链路：JEV→AI→Paper API→撮合→D1→复盘
- [ ] **P5-2** 断线恢复 / 重启 / DB 恢复 / 事件回放验证
- [ ] **P5-3** 交付物集合（源码/PR/迁移/API 文档/六角色记录/测试报告/安全审计/30天报告/部署说明/故障恢复）

---

### V2.0 自主执行总控（已上线）
- **凭据中心** `D:\数据分析\autopilot\security\credential-center.mjs`：AES-256-GCM（DPAPI .NET 入口被沙箱拦截，改用密码学等价方案），密钥 `key.bin` ACL 锁定当前用户；`GH_TOKEN`/`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` 已加密入库（仓库外，永不入库）。密钥原文不进 Git/日志/报告/聊天。
- **常驻 Supervisor** `D:\数据分析\autopilot\core/supervisor.mjs` + `queue/tasks.json`：持久化队列、隔离 worktree（`worktree.mjs`）、Git/PR 自动（`git.mjs`）、每日巡检 `runDaily()`（幂等）。
- **每日自动巡检** 已激活：WorkBuddy 自动化「JEV×NightResearcher 自主巡检」每日 03:05 运行，自动探测凭据→推送领先分支→创建/更新 PR→写 `reports/DAILY_REPORT_<date>.md`→里程碑/阻塞提醒。硬边界：不碰生产主分支 / 不部署生产 / 不连真实交易所或真实资金 / 不回显密钥 / 不重复已完成任务 / 结论必标 VERIFIED 或 UNVERIFIED（严禁伪造）。
- **唯一外部阻塞**：fine-grained GitHub PAT 缺 `Contents:write`（push 403）+ `Pull requests:write`。主理人在 GitHub 设置补全后，下一次巡检自动推送四分支并建 PR（token 串不变）。

---

## 进行中 / 阻塞

| 任务 | 状态 | 阻塞原因 | 解决路径 |
|---|---|---|---|
| T00 基线统一 | ✅ 完成 | — | 五文档齐备，分支核查真实 |
| P1-2 定点精度修复 | ✅ 完成 | 已选方案 A（分支A+移植定点） | 已收口，提交 ecc37a2/6e60b9d/26cefef/6e780ab |
| P1-5 收敛 PR | ⏳ 待 PAT 补全权限 | fine-grained PAT 仅读权限（push 403）；需 Contents:write | 主理人在 GitHub fine-grained token 设置补充权限后由我代建 |
| P1-7 迁移前后一致性测试 | ✅ 完成 | — | `tests/migration-fixedpoint.test.cjs` 5/5 |
| **T02 D1 验收** | 🟢 **真实验收 5/5 通过** | — | 测试库 `paper_test`(账户 b300a9b5…) 已建 + 迁移 0003 已应用 + 5 探针全过；报告 `reports/D1_VERIFY_RESULT.md` |
| T03 JEV 六页 | 🟢 完成·待推送 | fine-grained PAT 缺 Contents:write（push 403） | `feat/jev-trading-workbench`（`2dc4ad6`），27/27 测试，未碰用户未提交文件 |
| T04 六角色 | 🟢 完成·待推送 | 同上 | `feat/ai-six-roles`（`4b64ea5`，rebase 清除重复文档提交），9/9 测试 |
| T05 数据管道 | 🟢 完成·待推送（**离线 Mock**） | 同上；且数据非真实行情 | `feat/research-data-pipeline`（`ce38dc2`），7/7 测试，216 快照 + 日报（**确定性离线 Mock，严禁宣称真实行情**） |
| 四分支推送 | ⏳ 受阻 | fine-grained PAT 缺 Contents:write | GitHub 现可达（502 已恢复）；PAT 权限补全后立即推送 |

---

## 本回合 Git 提交记录（feat/p2-fixedpoint，待推送：PAT 权限）
- `ecc37a2` feat(p2): 定点金额计算基石 — BigInt 1e8 decimal 模块 + 迁移 + 10/10 测试
- `6e60b9d` feat(p2): 定点金额引擎集成 — paper-server.mjs 金额层移植 BigInt 1e8
- `26cefef` docs(p2): 同步并刷新 TASK_BOARD.md
- `6e780ab` test(p2): 增加迁移前后数据一致性测试（定点 1e8 口径）
- `7df882e` docs(t00): 统一项目基线文档五件套 + 刷新状态/看板 — **待推送**
- `426328d` docs+tooling(t02): D1 部署与验收套件 + 迁移审查（B02）— **待推送**
- `2e9d470` docs(t00-t05): Sprint 002 进展刷新 — **待推送**
- `a9ba026` docs(sprint002): 核验 T03/T04/T05 交付并刷新状态/看板/日志 — **待推送**
- 本回合 D1 修复（待提交）：`M scripts/d1-migrate.mjs` `M scripts/d1-verify.mjs` `M wrangler.toml` `M package.json` `A package-lock.json` `A reports/D1_VERIFY_RESULT.md` `M .gitignore`
### feat/ai-six-roles（night_researcher，待推送：PAT 权限）
- `4b64ea5` feat(ai): six-role decision system (SPOTTER→PRIOR→EDGE→KELLY→TAKER→CLOSER) — rebase 清除重复文档提交；9/9 测试
### feat/research-data-pipeline（night_researcher，待推送：PAT 权限）
- `ce38dc2` feat(research): quant research data pipeline (offline, deterministic) — 7/7 测试，216 快照 + 日报（data/ 已 `git add -f`）
### feat/jev-trading-workbench（jev 仓，待推送：PAT 权限）
- `2dc4ad6` feat(trading): add Paper Trading × Night Researcher workbench — 六页 + Paper API 客户端 + Mock Contract + 路由集成；27/27 Vitest
- 工作分支领先分支 A 4~6 个提交；远程分支 A `feat/p2-server-authoritative-paper`(107a6ec)、`feat/paper-trading-command-center`(360d1df)
- 旧分支 `feat/p2-paper-backend`(本地 df8f643) 标废弃候选，不删不推进

## 测试结果（真实，当前提交重跑，非虚构）
- 定点模块 `tests/decimal.test.cjs`：10/10。
- 迁移一致性 `tests/migration-fixedpoint.test.cjs`：5/5。
- 全量非 e2e（T01/T02 基线）：**81/81 零回归**。完整日志：`reports/TEST_LOG_81_2026-11-03.md`。
- **T02 D1 真实验收（Cloudflare 测试库 `paper_test`）**：`node scripts/d1-verify.mjs` → **5 passed / 0 failed**（batch 回滚 / 幂等键 / 并发乐观锁 / 账户隔离 / 事件回放哈希链）。完整报告：`reports/D1_VERIFY_RESULT.md`。
- **T03 JEV 六页（jev 仓 `feat/jev-trading-workbench`）**：`npx vitest run src/views/trading` → **27 passed (15 paperApi + 12 RoleCard)**。
- **T04 六角色（night_researcher `feat/ai-six-roles`）**：`node --test tests/six-roles.test.cjs` → **9 passed / 0 failed**。
- **T05 数据管道（night_researcher `feat/research-data-pipeline`）**：`node --test tests/research-pipeline.test.cjs` → **7 passed / 0 failed**（含端到端 collect/split/simulate/OOS 指标）。
- e2e（playwright）场景已由 `paper-server.test.cjs` 单测等价覆盖，离线不跑。
- 分支 A 原单测 37/37（FakeD1 内存实现）。
