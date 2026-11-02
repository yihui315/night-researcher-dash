# JEV Trading Desk Integration Contract

状态：接口与集成方案基线；**尚未写入本地 JEV 源码**。  
目标：把 Night Researcher 作为 JEV Command Center 的量化交易模块，而不是维护第二套独立控制台。

OpenAPI 契约：`docs/jev-trading-openapi.yaml`（规划接口，当前尚未实现）。

## 1. 集成原则

- 复用 JEV 当前 React 19 + Vite + Three.js 应用、路由、主题、布局、权限、Provider Center。
- JEV Provider Center 是唯一模型凭据入口；调用端只传 provider id，不把 API Key 放进组件 state、localStorage、URL、日志或请求快照。
- 本机 JEV backend 通过已存在的本地服务接口（当前项目记录：4779）访问交易研究服务；前端沿用 JEV 前端（当前项目记录：4780）。
- Night Researcher 负责 market data、backtest、agent research、paper engine、risk gate、ledger；JEV 负责控制台、身份/权限、provider credential、人工审批 UX。
- Live 交易 API 在默认配置中关闭。任何模型不能创建订单。

## 2. 目标目录（按现有 JEV 结构适配，不强制重建）

建议以模块形式挂载：
- `src/features/trading/`
  - `routes/CommandCenter.tsx`
  - `routes/TradingDesk.tsx`
  - `routes/MarketUniverse3D.tsx`
  - `routes/StrategyLab.tsx`
  - `routes/PaperPortfolio.tsx`
  - `routes/AgentTeam.tsx`
  - `components/MarketChart.tsx`
  - `components/OrderBook.tsx`
  - `components/AgentRunTimeline.tsx`
  - `components/RiskGatePanel.tsx`
  - `services/tradingApi.ts`
  - `types.ts`

Provider Center 不在 Trading feature 内重复造轮子：
- MiniMax M3：Provider ID 例如 `minimax-m3`。
- Qwen Coder：Provider ID 例如 `qwen-coder-next`。
- Provider 配置记录保存 endpoint/model/region/workspace metadata。
- Secret 值由 JEV DPAPI SecretStore 读写；前端仅显示已配置/未配置，不返回明文。
- Qwen Coding Plan `sk-sp-` 不允许进入自动化应用后端。若要使用，只能由用户在获准的交互式编程工具中使用。

## 3. JEV backend 对接接口（建议版本化）

所有接口由 JEV 4779 backend 代理/鉴权，不让浏览器直接持有 API Key。

| Method | Path | 作用 |
|---|---|---|
| GET | `/api/v1/trading/health` | 数据服务、研究引擎、Paper Engine 健康状态 |
| GET | `/api/v1/trading/market/snapshot` | 多资产行情快照及来源时间戳 |
| GET | `/api/v1/trading/market/orderbook?venue=...&symbol=...` | 结构化盘口 |
| POST | `/api/v1/trading/research/runs` | 创建六角色研究任务，传 provider id 和快照引用 |
| GET | `/api/v1/trading/research/runs/{runId}` | 获取 Agent 输出、usage、失败步骤 |
| GET | `/api/v1/trading/strategies` | 策略状态、版本和验证指标 |
| POST | `/api/v1/trading/paper/orders` | 用户点击确认后创建模拟订单 |
| GET | `/api/v1/trading/paper/account` | 账户净值、持仓、订单、成交和账本 |
| POST | `/api/v1/trading/paper/orders/{orderId}/cancel` | 撤销模拟挂单 |
| GET | `/api/v1/trading/events` | SSE/WS 事件流 |

Live 接口暂不实现。未来只有在单独部署审批后，才增加人工审批路由；不得复用 Paper endpoint 直接切换模式。

## 4. 事件合同

建议统一事件 envelope：
```json
{
  "event_id": "uuid",
  "event_type": "market.tick",
  "schema_version": "1.0",
  "event_time": "ISO-8601",
  "received_at": "ISO-8601",
  "source": "binance-spot",
  "run_id": null,
  "payload": {}
}
```

事件类型：
- `market.tick` / `market.orderbook` / `market.trade`
- `agent.started` / `agent.result` / `agent.failed`
- `strategy.gate_passed` / `strategy.gate_rejected`
- `risk.approved` / `risk.rejected`
- `paper.order.created` / `paper.order.filled` / `paper.order.cancelled`
- `paper.position.updated` / `paper.trade.closed`
- `strategy.suspended` / `strategy.retired`

## 5. 前端页面路由

在 JEV 原有导航与布局下增加 Trading 模块：
1. `/trading/command-center`
2. `/trading/desk`
3. `/trading/market-universe`
4. `/trading/strategy-lab`
5. `/trading/paper-portfolio`
6. `/trading/agent-team`

共享 Provider Center 继续放在 JEV 全局模型设置内，不再另建一个与 JEV 脱节的 API Key 管理页。

## 6. 组件与数据职责

- React/Lightweight Charts：精确 K 线、成交、订单簿、账户曲线、策略指标。
- Three.js：有来源的资产关系、流动性/风险地形；只有实际数据支持时才绘制资金流边。
- Agent Timeline：展示 SPOTTER → PRIOR → EDGE → KELLY → TAKER → CLOSER 的输入摘要、证据、输出、模型版本、耗时、Token 用量。
- Risk Gate Panel：展示确定性风控的 pass/reject 规则和原因；不接受 Agent 覆盖。
- Paper Order Ticket：用户手动确认，提交前重新读取盘口和账户快照。
- Strategy Lab：展示样本量、胜率置信区间、Expectancy、Profit Factor、Sharpe、Sortino、MDD、OOS、slippage sensitivity、Monte Carlo。

## 7. 集成验收

- 不复制 JEV 的登录、导航、主题、Provider Center 或 DPAPI SecretStore。
- Provider API Key 不出现在浏览器 localStorage、sessionStorage、DOM 文本、日志和网络快照。
- 同一个 run_id 能关联快照、Agent 结果、风险决策、模拟订单和成交。
- Agent 失败/超时/输出 JSON 无效时，研究任务标记失败，不创建订单。
- Kelly 没有已验证 OOS 数据时必须返回 0。
- TAKER 永远只生成提案；Paper Order 只有用户点击确认后才创建。
- 3D 视图不得把手续费代理画成某个代币资金流。
- Live Trading 默认关闭，自动化测试中不存在真实交易所下单调用。

## 8.1 API 已启动后的集成边界

用户已反馈 JEV API 已运行。当前项目记录的本机拓扑是：
- JEV backend：`127.0.0.1:4779`
- JEV React/Vite frontend：`127.0.0.1:4780`
- JEV 本地源码根：`D:\\jev`，历史 release 分支：`release/jcc-v1.3-final`

这里要区分两个状态：
1. **Provider API 可用**：JEV ProviderRegistry / ModelRouter 能调用 Jev 与 MiniMax，证明模型连接与凭据来源可用。
2. **Trading API 可用**：`/api/v1/trading/*` 仍是本文件中的目标接口合同，不能因为 `/api/health` 或 `/api/v1/domain/route` 已运行，就宣称行情、研究运行历史、策略仓库和 Paper Engine 接口已经实现。

集成时的硬要求：
- 以 JEV Provider Center / DPAPI SecretStore 为唯一凭据来源。Trading Desk 传 `providerId`，不得再要求用户在交易模块重复输入 API Key。
- JEV `ModelRouter` 负责决策模型路由；MiniMax/Qwen 等执行 Provider 由 JEV 后端解析。浏览器不得直接访问模型厂商 API。
- Cloudflare Pages 上的 Night Researcher 预览站不能直接访问用户本机 `127.0.0.1:4779`。正式嵌入时必须由 JEV 的 4780 前端加载 Trading React 模块，并通过同源 Vite/production proxy 访问 4779；不要把 localhost API 地址写进云端静态页面。
- 先完成 JEV 4779 的只读 health / market / research-run endpoints，再接 Paper account/order endpoints；Paper Engine 必须由服务端重新读取盘口并独立计算，不能信任浏览器提交的成交价或风险结果。
- 本轮在 Night Researcher 仓库新增的 D1 是云端预览的审计/恢复日志，不替代 JEV SQLite/数据库中的权威服务端 Paper Ledger。

## 8. 当前阻塞与需要的工程输入

当前 GitHub 连接中可访问的是 `yihui315/night-researcher-dash`，没有找到 JEV 源码仓库；JEV 是用户本机项目（历史记录路径 `D:\\jev`）。因此目前可以完成 Night Researcher 后端、API 合同、Agent 与风险模块，但不能诚实地声称已把 React 页面写入或运行在本机 JEV。

真正完成 JEV 联调需要把 JEV 源码仓库授权给当前 GitHub 连接，或提供当前 `D:\\jev` 源码包/关键目录（至少 package.json、src 路由/布局、Provider Center、4779 backend route/secret store）。拿到后直接按上述合同把模块挂入现有项目，不新建第二个独立前端。
