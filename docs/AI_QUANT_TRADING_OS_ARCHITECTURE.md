# AI Quant Trading OS — 架构审计与实施基线

版本：V1.2  
审计日期：2026-11-02  
当前仓库：`yihui315/night-researcher-dash`  
开发分支：`feat/paper-trading-command-center`

## 0. 当前结论

本仓库已经具备研究回测、Binance 公共现货行情、浏览器本地模拟账户、MiniMax/Qwen BYOK 接口和六角色研究流程的第一条纵向链路，但**尚不是完整的 AI Quant Trading OS，也尚未接入 JEV React/Vite 主界面**。

当前运行边界：
- 研究与模拟交易允许；真实交易、钱包连接、真实交易 API Key 和真实订单全部关闭。
- AI 只生成研究结论和候选提案。
- KELLY 仓位计算、TAKER 订单提案和 Paper Engine 风险检查由确定性代码完成。
- 任何 Agent 都不能调用下单工具、写交易账本或绕过风险闸门。
- 缺失数据必须为 `unknown`，不能把 BTC 网络费率当成 RUNES/BRC20/CRC20 代币价格。

## 1. 六层目标架构

```text
CEX / DEX / Bitcoin L1 / BRC20 / RUNES / CRC20
                    |
                    v
          1. Real-time Data Center
                    |
                    v
       2. Market Analysis & Signal Engine
                    |
                    v
  3. AI Team: SPOTTER -> PRIOR -> EDGE
                    |
                    v
  4. Independent Validation & Risk Gate
        |                         |
        v                         v
   Paper Trading          Human-approved Live
        |                         |
        +------------+------------+
                     v
        5. Ledger, Review & Learning
                     |
                     v
         6. JEV React / 2D + 3D Desk
```

### Layer 1 — 实时市场数据中心

目标数据域：
- CEX：现货 ticker、K 线、逐笔、盘口；后续接永续 funding、OI、liquidations。
- DEX：池子储备、swap、LP、池深、滑点曲线。
- Bitcoin L1：区块、mempool、手续费、UTXO/交易证据。
- BRC20 / RUNES / CRC20：代币级成交、订单簿/池深、供应/铸造、持有人变化、协议事件。

每条数据必须保留：
`source`、`instrument`、`venue`、`event_time`、`received_at`、`sequence`、`price_type`、`payload`、`freshness`、`confidence`。

价格字段不可混用：
- `latest_trade`：最近一笔已确认成交。
- `best_bid / best_ask`：当前可读取订单簿。
- `recent_vwap`：明确时间窗内按成交量加权的成交均价。
- `index / mark / floor`：独立字段，不得冒充可成交价格。

当前实现与缺口：

| 数据域 | 当前实现 | 审计结论 |
|---|---|---|
| BTC/ETH/ORDI/1000SATS 现货 | Binance 公共 REST + WebSocket ticker/depth20/trade | 已有基础连接；浏览器 CI 用模拟数据，不等于生产链路已验收 |
| K 线 | Binance REST，1m/15m/1h/4h/1d | 已有 |
| 订单簿 | Binance depth20 部分深度流 + 定时 REST 快照 | 可做演示撮合；尚非 diff-depth 序列重建 |
| 永续资金费率 | `connectors_extra.py` Bybit/Binance 尝试 | 当前数据可能 unknown；未建立稳定验收 |
| 爆仓 | CoinGlass/Binance 连接器骨架 | API Key/端点与权限需复核 |
| RUNES | UniSat/Dune 连接器骨架 | 当前没有可持续、已验证的代币级成交深度 |
| Bitcoin L1 | mempool/网络手续费指标 | 只能作为网络活跃度代理，不能代表某个 Rune 价格 |
| CRC20/LEAF | 已接入 `crc20.org/api/v1/status`、`stats/LEAF`、`history`；分开读取 marketplace sale 与 AXBT/LEAF pool swap | best bid/ask、6h VWAP、统一 latest_trade 仍 unknown；需与 `crc.garden/activity` 和 Bitcoin 区块交叉核验 |
| DEX | 尚未接入 | 未完成 |

P1 数据接入顺序：
1. Binance Spot depth diff + sequence 校验、交易所 exchangeInfo 过滤器。
2. Binance/Bybit funding、OI、liquidations，数据缺失时显式 unknown。
3. UniSat/Dune RUNES token-level trades/holders/market depth。
4. CRC20/LEAF：基础 indexer/status/stats/history connector 已完成；继续验证 latest confirmed trade、6h VWAP、best bid/ask（只有真实订单簿存在才显示）、holders/supply/events。
5. DEX pool reserves/swaps/LP 数据，按池子和区块时间保存。

### Layer 2 — 行情分析与信号引擎

当前浏览器规则观察：
- EMA20 / EMA50。
- RSI14。
- 前 10 档盘口不平衡。
- K 线、盘口价差、逐笔成交流。

重要限制：
- 当前分数是解释性市场状态观察，不是已验证交易信号。
- 当前 depth20 WebSocket 是部分深度快照，不是完整 diff-depth order book replay。
- 需要加入数据新鲜度门槛、成交量异常、spread/depth、冲击成本、波动状态和链上事件标准化。
- 3D 节点当前只展示观察资产，不代表资金流、相关性或资金迁移。

### Layer 3 — AI 策略研究团队

六个角色的边界：

| Agent | 职责 | 输出 | 禁止事项 |
|---|---|---|---|
| SPOTTER | 从给定快照发现候选机会 | 候选标的、证据字段、缺失数据 | 编造市场数据 |
| PRIOR | 判断市场状态和先验 | regime、支持/反证、unknown | 把主观置信度说成统计概率 |
| EDGE | 评估是否存在可证伪优势 | 假设、入场触发、失效条件、成本测试 | 自行伪造胜率和样本量 |
| KELLY | 计算保守仓位 | Wilson 下界 + 1/4 Kelly + 上限 | 不满足样本与 OOS 时给出非零仓位 |
| TAKER | 生成交易提案 | 交易对、方向、参考盘口、建议金额/数量 | 直接提交订单 |
| CLOSER | 审查退出、失效和复盘 | exit conditions、failure modes、next validation | 批准实盘或覆盖风控 |

当前实现：
- `/api/agents/research` 按顺序调用 SPOTTER、PRIOR、EDGE、CLOSER。
- KELLY 与 TAKER 是确定性程序，不调用 LLM。
- 当前六角色共享同一组 Provider/Model 配置；未来在 JEV Provider Center 按 Agent 映射不同模型。
- 当前是串行角色提示词工作流，不应宣传为六个独立模型/自治 Agent 集群。
- KELLY 的 Wilson 下界 + 1/4 Kelly 计算函数和 TAKER 提案函数已有单元测试；但 Agent API 当前刻意向 KELLY 传入 `null`，不接受浏览器提交的策略统计，原因是服务端可信研究账本尚未建设。因此当前线上流程 KELLY 恒为 0，TAKER 恒阻断；未来接入服务端签名/版本化研究结果后才能解锁。

### Layer 4 — 独立验证、风险与执行

验证项：
- 交易成本：手续费、价差、滑点、盘口冲击。
- 样本内 / OOS / 多周期 / 多资产 / rolling vintage。
- Walk-forward 必须在每个 fold 只用该 fold 之前的数据拟合/选择，再在后续窗口验证。
- Monte Carlo：交易顺序重排、bootstrap、成本扰动、参数扰动。
- 指标：胜率及置信区间、Expectancy、Profit Factor、Sharpe、Sortino、Max Drawdown、OOS、滑点敏感性、市场状态分层。

现状审计：
- 回测引擎已有事件驱动下一根 K 线开盘成交、OHLC 止损、交易成本、胜率、平均盈亏、Profit Factor、Expectancy、Payoff Ratio、Max Drawdown。
- 已有 730 天窗口、90 天 OOS、参数网格和多个 vintage 的研究框架。
- 本轮已将 `rolling_oos` 替换为严格 `walk_forward_oos`：每个 fold 只用验证开始前的数据选择参数，再用新策略实例在独立 90 天窗口从空仓验证；训练与验证上下文均按时间截断。
- 新增 CRC20 LEAF 连接器：status、stats、history；marketplace sale 与 pool swap 分开；sat/LEAF → USD 仅作为 BTC/USDT 参考价派生值；best bid/ask 与 6h VWAP 未从不支持的 API 臆测。
- Sharpe/Sortino、Monte Carlo、交易级滑点/冲击回放尚未完成；walk-forward 也需要真实数据运行后的结果审查。
- 当前策略报告中的策略均未通过全部门禁，不允许晋级。

Paper Engine 当前约束：
- 初始资金 10,000 USDT。
- 单笔不超过净值 10%；总敞口不超过 40%。
- 单日亏损 -3% 熔断；账户回撤 -10% 熔断。
- 现货多头；不支持杠杆、裸卖空、提现或钱包。
- 市价模拟按可见盘口逐档计算；限价单不模拟交易所队列优先级。
- 账户只保存在当前浏览器 localStorage；不是服务端持久账本，清理浏览器数据会丢失。
- 交易对数量精度/最小数量/价格 tick 规则、部分成交和交易所真实手续费模型仍需补齐。

Live Trading：
- 当前完全关闭。
- 未来只允许：策略通过所有门禁 → Paper 连续验证 → 人工批准 → 独立 Live Risk Service 再校验 → 人工确认订单。
- 必须具备 kill switch、单日/单策略/总账户限额、幂等订单 ID、订单状态 reconciliation、只减仓权限和审计日志。

### Layer 5 — 交易记录与持续学习

目标：
- append-only event ledger：MarketEvent、Signal、AgentRun、RiskDecision、OrderIntent、Order、Fill、PositionSnapshot、StrategyVersion。
- 每次研究保留 `run_id`、数据快照 hash、strategy version、model/provider、prompt version、usage、risk decision。
- 失败原因分类：数据过期、假突破、成本吞噬、样本不足、过拟合、regime shift、执行偏差。
- 策略生命周期：Candidate → Backtest → OOS → Paper → Human Approval → Live → Suspended/Retired。
- 策略晋级/降级由确定性门禁和人工审批决定，不能由 LLM 自行决定。

当前缺口：
- 只有浏览器 localStorage 交易状态，没有 append-only 服务端账本。
- 没有跨设备账户、策略版本仓库、回放服务或自动淘汰调度器。
- 建议开发阶段 SQLite + append-only event table；多进程/生产阶段 PostgreSQL。

### Layer 6 — JEV 3D 交易指挥中心

目标技术：
- 复用现有 JEV React 19 + Vite + Three.js 主应用和 Provider Center。
- Lightweight Charts 用于精确 K 线/成交；Three.js 用于市场生态关系、资金流和风险分布。
- 3D 只呈现有证据的节点和边：边必须包含来源、时间窗、数值单位、置信度；无证据时不绘制资金流边。
- 2D 负责交易决策与订单确认，3D 负责态势感知，不互相替代。

六个页面：
1. AI 交易指挥中心：净值、市场状态、机会排名、风险警报、Agent 决策。
2. 专业交易工作台：K 线、深度、逐笔、模拟订单、持仓。
3. 3D 市场宇宙：资产节点、已验证的资金流边、生态地形、风险热区。
4. 策略竞赛实验室：回测、OOS、Monte Carlo、策略排名和淘汰。
5. 模拟交易账户：资金曲线、订单、成交、费用、盈亏、回撤。
6. AI 专家团队：六角色输入输出、意见分歧、证据引用、模型版本和审计日志。

当前缺口：
- 本仓库仍有静态 HTML 原型；尚未将页面迁入 JEV React Router/组件体系。
- 本次开发新增 Provider Center 顶部入口只是 Night Researcher 预览页面的临时可发现性修复，不代表 JEV 已完成集成。
- JEV 本地源代码目前不在此 GitHub 仓库/当前连接的远程仓库中；真正挂载 React 页面、调用 JEV Provider Center DPAPI SecretStore、接入 4779 后端，必须在可访问的 JEV 源码上完成并验收。

## 2. Provider 配置基线

### MiniMax M3
- 模型：`MiniMax-M3`。
- 官方 OpenAI 兼容 base URL：`https://api.minimaxi.com/v1`。
- API Key 在 Provider Center 输入；不得提交 Git。
- MiniMax 官方文档也提供 Anthropic 兼容路径，支持 thinking block；当前应用走官方 OpenAI 兼容 Chat Completions。

### Qwen Coder / Model Studio
- 首选编码模型：`qwen3-coder-next`；兼容旧版 `qwen3-coder-plus`。
- 研究模型：`qwen3.8-max`、`qwen3.7-plus`。
- Model Studio API Key 必须与 Workspace ID 和地域匹配；本应用走 Model Studio 按量 OpenAI-compatible endpoint。
- `sk-sp-` 是 Coding Plan 专用 Key，必须配套 `coding.dashscope.aliyuncs.com`；官方条款限定用于交互式编程工具，禁止用于自动化脚本或应用后端。本应用不得接收它。
- 当前页面仅在内存中保留 key；正式 JEV 集成应通过 Provider Center + DPAPI SecretStore 在本机加密保存，前端只引用 provider id，不读取明文 key。

## 3. 必须维持的安全不变量

1. LLM 输出永远不是可执行订单。
2. Kelly 只读取通过门禁的历史统计，不读取 LLM 自报胜率。
3. TAKER 只能生成提案；必须经过确定性 Paper Engine / Live Risk Engine。
4. 所有订单都要校验交易对白名单、数据新鲜度、价格、数量、余额、敞口、日亏损、回撤、幂等 ID。
5. Agent/模型不可写 ledger，不可改变 risk policy，不可解锁 Live。
6. Live Trading 默认 feature flag OFF；生产启用需人工确认和单独部署审批。
7. 所有价格、成交、深度、链上状态必须有来源和时间戳；无法核实即 unknown。

## 4. 阶段验收

| 阶段 | 验收 |
|---|---|
| P0 基线/回测可信 | 严格 Walk-forward 已实现；补 Sharpe/Sortino/Monte Carlo；持续验证无前视 |
| P1 数据中心 | CEX depth sequence；Funding/OI/liquidations；RUNES/CRC20 代币级市场数据 |
| P2 Paper Trading | 交易规则过滤器、部分成交、服务端 ledger、回放与幂等 |
| P3 JEV 集成 | JEV React 19 页面、Provider Center/DPAPI、4779 API、WebSocket event bus |
| P4 Live 人工审批 | 独立 Live Risk、人工二次确认、限额、kill switch；本阶段前保持关闭 |

## 5. 当前本轮已做的纵向增量

- Provider Center 从交易页侧栏移到首屏主区域，并增加顶部锚点入口。
- Qwen allowlist 加入 Qwen3-Coder-Next、Qwen3-Coder-Plus、Qwen3.8-Max 等当前 Model Studio 模型。
- 修复 WebSocket close handler 中未定义的 `symbol` 引用，并加入 generation guard 防止旧连接覆盖新交易对。
- 新增六角色研究 API；四个 LLM 角色串行输出结构化 JSON，KELLY/TAKER 由确定性代码运行；KELLY 目前只接受未来的服务端可信研究指标，不接受客户端快照。
- 新增 Kelly Wilson 下界、1/4 Kelly、10% 上限；未通过样本/OOS 门禁时仓位为零。
- TAKER 只能返回 proposal，不能调用 paper/live order。
- 新增严格 Walk-forward、CRC20 数值精度/索引同步、六角色/Kelly/TAKER 测试和浏览器 E2E；真实 Provider Key 联调仍需用户在界面中输入并点击连接测试。
