# WorkBuddy 一次性任务：JEV Trading Desk 正式集成

任务类型：本机源码集成；不是重新建设 Provider Center，也不是部署实盘。

## 已知环境与前提

- JEV 本机根目录：`D:\\jev`（不要使用历史误写的 `F:\\jev`）。
- JEV API：`127.0.0.1:4779`；React/Vite 前端：`127.0.0.1:4780`。
- 当前 JEV release branch 记录：`release/jcc-v1.3-final`。开始前必须重新读取实际 branch、HEAD、git status；不得假设仍与历史报告一致。
- 用户已反馈 JEV API 已运行；不要重新索取或打印 API Key。Provider 凭据继续由 JEV Provider Center / DPAPI SecretStore 管理。
- Night Researcher 集成来源：`https://github.com/yihui315/night-researcher-dash`，PR #1 的 `feat/paper-trading-command-center` 分支。先读取最新 PR HEAD，再从该分支取 `integration/jev/tradingApi.mjs`、`integration/jev/tradingApi.d.ts`、`docs/jev-trading-openapi.yaml` 和本文件引用的架构合同。
- Night Researcher Cloudflare D1 只用于云端预览审计/恢复；JEV 本机权威账本必须使用 JEV 自身持久化层，不得把客户端快照当作权威成交。

## 0. 安全边界（最高优先级）

1. 仅启用 Research + Paper；Live Trading、钱包、交易所账户密钥、提现、杠杆、真实订单一律保持关闭。
2. AI Agent 只能提出研究结论。仓位、风险、订单校验和模拟成交必须由确定性服务端程序执行。
3. TAKER 只输出提案；用户点击确认后，服务端重新读取最新盘口与账户状态，再执行 Paper Engine。
4. 没有真实 OOS 统计时 KELLY=0；不能用浏览器上传的胜率、盈亏或账户快照给 Kelly 供数。
5. 任何 API Key、DPAPI secret、WorkBuddy 凭据、token、Cookie、签名材料不得进入前端 state、localStorage、URL、日志、测试 fixture 或 artifacts。
6. 不得改写或绕过 JEV 的 Human Approval、Control Auth、Audit、SecretStore、DPAPI、ProviderRegistry、ModelRouter、Provider Center、Health 和 A8 freeze 约束。
7. 不得使用 `git add -A`；不得清理、stash、覆盖或提交与本任务无关的既有 dirty/untracked files。

## 1. 基线审计（先只读）

- 进入 `D:\\jev`，确认根目录、实际 branch、HEAD、工作区状态、Python/Node 版本、前后端端口。
- 读取 JEV 当前 API 路由注册机制、frontend router/layout、Provider Center、ModelRouter、SQLite/数据库层、SSE/Event bus。
- 读取 A8 freeze 测试和受保护文件清单。先明确哪些文件可以安全扩展。
- 实测 `GET /api/health`，保存非敏感字段：HTTP 状态、provider mode、Jev/MiniMax display state、model id、时间戳。禁止读取或输出 secret 值。
- 若 Provider Center 与 /api/health 不一致，先停止 Trading 集成并报告；不得在本任务中修改 Provider 基线。

## 2. Git 隔离

- 从当前实测 HEAD 建立新分支：`feature/jcc-trading-desk-integration`。
- 只提交本任务新增/修改文件；先输出变更清单和 protected-file diff 检查。
- 若必须修改被 A8 冻结的 `server.py` 或其他受保护文件，先停止并报告所需 re-baseline 范围；不得自行删除/弱化冻结断言。只有遵循 JEV 既有 freeze procedure 才能继续。

## 3. 前端挂载

将 Trading Desk 作为 JEV 原生 feature，而不是 iframe 或第二个独立站点：

```
frontend/src/features/trading/
  routes/CommandCenter.tsx
  routes/TradingDesk.tsx
  routes/MarketUniverse3D.tsx
  routes/StrategyLab.tsx
  routes/PaperPortfolio.tsx
  routes/AgentTeam.tsx
  components/MarketChart.tsx
  components/OrderBook.tsx
  components/AgentRunTimeline.tsx
  components/RiskGatePanel.tsx
  components/PaperOrderTicket.tsx
  services/tradingApi.ts
  types.ts
```

- 使用 JEV 现有 React 19、Vite、路由、主题、布局、权限与 Three.js。
- 把 `integration/jev/tradingApi.mjs` 与声明文件合并进 JEV 的 service layer，默认同源 `/api/v1/trading`。
- Provider 选择器读取 JEV Provider Center 的 provider IDs；不复制 MiniMax/Qwen API Key 输入框。
- 增加六个路由：Command Center、Trading Desk、3D Market Universe、Strategy Lab、Paper Portfolio、Agent Team。
- 图表、订单簿、逐笔和下单保持精确 2D；Three.js 只做资产关系/相关性/风险态势，不把手续费代理画成资金流。

## 4. 后端 API（必须服务端实现，不可用前端 mock 代替）

按 `docs/jev-trading-openapi.yaml` 实现或适配：
- `GET /api/v1/trading/health`
- `GET /api/v1/trading/market/snapshot`
- `GET /api/v1/trading/market/orderbook`
- `POST /api/v1/trading/research/runs`
- `GET /api/v1/trading/research/runs/{runId}`
- `GET /api/v1/trading/strategies`
- `GET /api/v1/trading/paper/account`
- `POST /api/v1/trading/paper/orders`
- `POST /api/v1/trading/paper/orders/{orderId}/cancel`
- `GET /api/v1/trading/events`（SSE）

实现要求：
- Research endpoint 接收 `providerId`，服务端从 JEV ProviderRegistry / ModelRouter 解析 provider/model/credential；绝不接受浏览器传入 apiKey。
- Research run 保存 `runId`、market snapshot hash、prompt version、provider/model、每个 Agent 的状态/输出/usage、开始/结束时间、失败代码和 risk decision。
- Paper endpoint 只接收订单意图与 human confirmation ID。服务端重新取市场数据、验证盘口时间戳/序列、精度/最小名义金额/现金/持仓/风险限额，再调用确定性 Paper Engine。
- 以 SQLite 或 JEV 当前持久化层实现 append-only event ledger；服务端生成 order/fill/risk events。客户端不能提交 server-owned event。
- 用幂等 clientOrderId 防重复；并发下单采用事务/乐观版本校验；账户恢复只读服务端快照。
- 对 stale/sequence_gap/unknown 盘口 fail closed；不允许用历史价格或本地缓存伪装实时 best bid/ask。
- SSE 事件必须带 event_id、schema_version、event_time、received_at、source、run_id、payload；断线支持 Last-Event-ID 恢复。

## 5. Agent 与风险门禁

保持六角色顺序：
`SPOTTER → PRIOR → EDGE → KELLY → TAKER → CLOSER`

- SPOTTER/PRIOR/EDGE/CLOSER 可由 JEV ModelRouter 分配真实模型。
- KELLY 必须由确定性代码执行，读取服务端已验证 OOS 指标；没有足够样本或 OOS 未过时返回 0。
- TAKER 只生成 proposal，不持有下单能力。
- CLOSER 可拒绝/要求补证，但不能覆盖 deterministic risk gate。
- 模型输出不是 JSON、超时、拒绝、provider unavailable、快照 stale 时，run 标记 failed/blocked，不产生 Paper order。
- 每个风险拒绝记录 rule_id、observed_value、threshold、decision、run_id。

## 6. 验收与门禁

必须独立运行，不得自证绿：
- Backend: JEV 核心测试、Trading API tests、DB transaction/idempotency、stale orderbook、risk gate、human confirmation、audit atomicity。
- Frontend: typecheck、vitest、build。
- Browser E2E: 真实 Chrome 4780，覆盖六个页面、Provider Center 状态一致、研究 run、Agent timeline、risk reject、用户确认 Paper order、取消挂单、刷新恢复、SSE reconnect。
- Security: secret leak scan；确认浏览器无 API Key；确认没有真实交易所下单请求。
- Regression: A8 freeze、Control Auth、Human Approval、Audit、Provider Health consistency 必须保持。
- 记录精确 commit、test counts、browser artifact path、health snapshot 和 blockers。任何未运行项写 NOT_RUN，不得写 PASS。

## 7. 完成条件

只有全部条件满足才可标记集成完成：
- JEV 4780 中出现 Trading 导航和六个页面。
- Provider Center 仍是唯一凭据入口，/api/health 与 Provider Center 状态一致。
- 同一 runId 关联 market snapshot、Agent 结果、risk decision、paper order/fill。
- 服务端 Paper Engine 和 append-only ledger 可恢复、可审计。
- 真实浏览器 E2E 通过，Live Trading 仍关闭。
- 提交 scoped commit；不自动合并 release/main，不创建最终 release tag，除非 JEV 原有 release gate 明确满足。
