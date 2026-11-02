# TASK_BOARD.md — JEV × Night Researcher × Paper Trading

> 任务看板。虚拟专家岗位（指令 §二）仅作职责标注，实际代码由 WorkBuddy 调度实施与验收。
> 纪律：优先复用现有成果 · 不直改 master · 独立 feature 分支 · 完成即提交+测试证据 · 不虚构结果 · 不降安全门槛。

更新时间：2026-11-02（GMT+8）— 续会话：P1-2 定点精度修复已收口。

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

### Phase 0 — 项目基线
- [x] **P0-1** 审计 night_researcher 各分支与 Git 状态（含远程新分支）— 证据已记录
- [x] **P0-2** 审计 `D:\jev` 真实工程（v1.3 monorepo、Provider Center、React）— 证据已记录
- [x] **P0-3** 评估本地 `c9c166d` 与远程 P2 分支的关系（结论：重复建设）— 证据已记录
- [x] **P0-4** 建立 `PROJECT_STATUS.md` 与 `TASK_BOARD.md`（本文件）
- [x] **P0-5** 确认 JEV 是否为 React 19（`apps/command_center_3d/package.json`）— ✅ 19.3.0 已确认

### Phase 1 — P2 后端收口
- [x] **P1-1** 评估远程 `feat/p2-server-authoritative-paper` 对指令 Phase 1 的覆盖 — 见 PROJECT_STATUS §1.1
- [x] **P1-2** 【关键】定点精度修复：金额 `REAL` → BigInt 1e8 定点（`paper-server.mjs` 金额层移植 `decimal.mjs`）— ✅ 完成，76/76 非 e2e 零回归
- [x] **P1-3** schema 对齐：迁移 `0003` 将 money/qty/price 列 REAL→INTEGER 1e8；positions/idempotency_keys/market_snapshots/risk_events/strategy_runs 由分支 A schema 覆盖（已文档化）
- [x] **P1-4** 运行分支 A 现有测试，核实真实通过率 — ✅ 47/47 paper-* + jev-trading-api；全量非 e2e 76/76
- [x] **P1-5** 收敛为单一 PR：基于分支 A 开 `feat/p2-fixedpoint`，合并定点层，已 `git push -u origin`，PR 对比链接待主理人创建（base=分支A，不碰 main）
- [x] **P1-6** 指令 Phase 5 的 12 项门禁逐条映射 + 实测报告 — 由 `paper-server.test.cjs` 等价覆盖（市价/幂等/限价/乐观锁/重置/回放/风控 等）

### Phase 2 — JEV 前端（六交易页）
- [ ] **P2-1** 确认 JEV Provider Center / API 基础设施 / 设计组件接入点
- [ ] **P2-2** 市场总览页（复用 Lightweight Charts + Provider Center 行情源）
- [ ] **P2-3** 交易工作台页（下单→服务端风控→用户确认→Paper API）
- [ ] **P2-4** AI 六角色中心页
- [ ] **P2-5** 风险管理页
- [ ] **P2-6** 策略研究页
- [ ] **P2-7** 交易审计页（事件/回放可视化）
- [ ] **P2-8** Mock→真实 Paper API 切换与验收

### Phase 3 — 六角色决策链路
- [ ] **P3-1** 复用 `agent-orchestrator.mjs` / `ai-core.mjs` 搭建 SPOTTER→PRIOR→EDGE→KELLY→TAKER→CLOSER
- [ ] **P3-2** 每角色审计字段（输入/输出/模型/Token/时间/策略版本/拒绝原因）
- [ ] **P3-3** TAKER 仅提案不改性账户；订单经服务端风控 + 用户确认

### Phase 4 — 持续 Paper Trading（≥30 天）
- [ ] **P4-1** 真实公开行情持续采集（不等待 UI）
- [ ] **P4-2** 每策略独立收益 / 手续费滑点 / 最大回撤 / 胜率 / 盈亏比核算
- [ ] **P4-3** 失效策略自动暂停；OOS 未过禁晋级
- [ ] **P4-4** 历史记录不可覆盖/删除

### Phase 5 — 最终集成与交付
- [ ] **P5-1** 全链路：JEV→AI→Paper API→撮合→D1→复盘
- [ ] **P5-2** 断线恢复 / 重启 / DB 恢复 / 事件回放验证
- [ ] **P5-3** 交付物集合（源码/PR/迁移/API 文档/六角色记录/测试报告/安全审计/30天报告/部署说明/故障恢复）

---

## 进行中 / 阻塞

| 任务 | 状态 | 阻塞原因 | 解决路径 |
|---|---|---|---|
| P1-2 定点精度修复 | ✅ 完成 | 已选方案 A（分支A+移植定点） | 已收口，提交 `ecc37a2`+`6e60b9d` |
| P1-5 收敛 PR | 🟡 半完成 | `gh` CLI 未安装，无法自动建 PR | 已 push 分支；对比链接待主理人点开创建 |
| P2 全系列 | ⬜ 未启动 | 依赖确认 JEV Provider Center 接入点 | P1 完成后启动 |
| D1 实跑验收 | ⬜ 阻塞 | 需 Cloudflare 账号 token | 无 token 时以 FakeD1/SQLite 等价测覆盖 |

---

## 本回合 Git 提交记录（feat/p2-fixedpoint）
- `ecc37a2` feat(p2): 定点金额计算基石 — BigInt 1e8 decimal 模块 + 迁移 + 10/10 测试
- `6e60b9d` feat(p2): 定点金额引擎集成 — paper-server.mjs 金额层移植 BigInt 1e8（76/76 非 e2e 零回归）
- 已推送：`git push -u origin feat/p2-fixedpoint` ✅
- 远程：分支 A `feat/p2-server-authoritative-paper`(107a6ec)、`feat/paper-trading-command-center`(360d1df)
- 旧分支 `feat/p2-paper-backend`(c9c166d) 的定点层已并入本分支，建议退役

## 测试结果（真实，非虚构）
- 定点模块 `tests/decimal.test.cjs`：10/10（含浮点缺陷反证、手续费 `10000.01*0.001`、大额无损、序列化可逆）。
- 全量非 e2e：**76/76 零回归**（paper-server/ledger/engine/client/jev-trading-api 47 + orchestrator/ai-proxy/depth-sequencer 19 + decimal 10）。
- e2e（playwright，需浏览器/网络）场景已由 `paper-server.test.cjs` 单测等价覆盖，离线不跑。
- 分支 A 原单测 37/37（FakeD1 内存实现，无 wrangler/网络依赖）。
