# 夜班交易研究员 · 运行说明

纯标准库（Python 3.8+），**无需 pip install**，零外部依赖。

## 1. 运行

```bash
cd night_researcher
python run_research.py
```

输出：`output/morning_report.md`（卡片 + 早报）。

## 2. 目录结构

```
night_researcher/
├── backtest_engine.py   # 核心：数据抓取 / 指标 / 回测 / 三道关卡 / 反过拟合 / 滚动OOS / 早报
├── strategies.py        # 策略注册表（FNG_EMA_MR 基准 + BRC20_RSI_MR 高频）
├── brc20_runes_monitor.py # BRC20/RUNES 生态监测（Bitcoin 手续费代理 + mempool 拥堵）
├── connectors_extra.py  # RUNES/资金费率/爆仓 连接器（可达环境可用，本环境优雅降级「未知」）
├── run_research.py      # 执行入口：双策略 + 交叉验证 + 生态监测 + 补充数据 → 早报
├── 设计文档.md          # 架构 / 数据来源 / 关卡编码 / 约束 / BRC20·RUNES 重点
├── data/                # 缓存（btc_fees.json 等，<24h 复用）
└── output/
    └── morning_report.md
```

## 3. 硬约束（务必遵守）

- ❌ 不写真实资金下单代码、不发送真实订单；允许独立的本地模拟撮合与模拟风控，不连接钱包或交易所账户。
- ❌ 不爬 X(Twitter) 等社媒；想法池由你**粘贴原帖链接 + 观点**提供。
- ⚠️ 拿不到的数据（如永续资金费率）标「未知」，**绝不虚构**。

## 3.1 实时前端仪表盘（`dashboard/`）

纯静态前端（零依赖、零后端），浏览器直连公开 API 实时刷新，可一键部署 Cloudflare Pages。

```
dashboard/
├── index.html            # 四大模块：实时快照 / 价格·指标 / 生态监测 / 研究结论
├── assets/
│   ├── charts.js         # 零依赖 Canvas 图表库（蜡烛+EMA200 / RSI / 量能 / 折线 / 柱状）
│   ├── research.js       # 研究结论兜底常量（JSON 加载失败时回退）
│   ├── app.js            # 实时数据层 + 轮询 + 红涨绿跌 + 研究 JSON 自动刷新
│   └── styles.css
└── data/
    └── research.json     # 由 run_research.py 生成，前端实时拉取（可开关自动刷新，默认 5m）
```

- **本地预览**：`cd dashboard && python -m http.server 8765`，浏览器开 `http://localhost:8765`。
- **研究结论实时化**：`run_research.py` 把卡片 / 交叉验证 / 网格 / 生态 的真实计算导出为 `data/research.json`（单一数据源）；前端 fetch 该文件并支持「手动刷新 + 默认 5 分钟自动刷新」。重跑 `run_research.py` 后浏览器自动拾取新数据（无需改代码）。
- **新增指标**：量能副图（K 线自带成交量）、BTC 永续资金费率卡片（`fapi.binance.vision` 镜像，浏览器直连，失败标「未知」）。
- **合规**：仅展示研究/行情，不写下单、不触发交易、不爬 X、不给建议。

## 3.2 部署（自动重跑 + 重部署）

- **临时/预览**：`workbuddy_sites_deploy` 发布 `dashboard/` 为静态站（已发布，线上链接见对话）；但这是静态快照，重跑 `run_research.py` 后需手动重新部署。
- **无人值守（推荐）**：见 **`部署指南.md`** —— 把本目录作为仓库推到 GitHub，Cloudflare Pages 连通仓库（Build output directory = `dashboard`），由 `.github/workflows/night-researcher.yml` 每天 UTC 16:00 自动重跑 `run_research.py` 并推送 `research.json`，**Pages 自动重新部署**，线上随即为最新。RUNES / 爆仓 真实数据只需在仓库 Secrets 填入 `UNISAT_API_KEY` / `DUNE_API_KEY`(+`DUNE_RUNES_QUERY_ID`) / `COINGLASS_API_KEY` 即自动启用，无需改代码。

## 4. 研究重点：BRC20 / RUNES

`brc20_runes_monitor.py` 用 **Bitcoin 每日网络手续费**（DefiLlama）作为 BRC20/RUNES 生态活跃度代理，叠加 `mempool.space` 实时费率，输出"生态监测"章节（事实+推断分离）。

- **BRC20 代币级回测已打通**：Binance 镜像 `data-api.binance.vision` 提供 ORDIUSDT / 1000SATSUSDT 等 BRC20 龙头现货 K 线，框架已纳入回测（见 `run_research.py` 的 `BRC20_SYMBOLS`）。
- **两套策略**：`FNG_EMA_MR`（恐贪极值+EMA 过滤，低频基准）与 `BRC20_RSI_MR`（4h RSI 对称均值回归，原生高频，用于填满 OOS）。
- **跨资产/周期交叉验证**：`backtest_engine.rolling_oos` 做 3-vintage walk-forward + 4h/1d 多周期对比，压制单资产过拟合嫌疑。
- RUNES 代币（如 DOG•GO•TO•THE•MOON）不上 CEX 现货，代币级价格在本环境不可达 → 仅以 BTC L1 手续费作活跃度代理，标「非代币价格结论」。
- **RUNES / 资金费率 / 爆仓连接器**（`connectors_extra.py`）已写好：可达环境或配置 API key 后自动取数；本环境优雅降级为「未知」，绝不虚构。

## 5. 如何新增一个策略

在 `strategies.py` 里新增一个类，实现：

```python
class MyStrategy:
    def __init__(self, **params):
        self.params = {...}                 # 参数（建议 ≤3 个，避免反过拟合标「可疑」）
        self.one_liner = "一句话想法"
        self.entry_rule = "进场条件"          # 第一关·说清楚
        self.exit_rule  = "离场条件"
        self.surrender_rule = "认输条件"
        self.edge_rationale = "优势凭什么存在" # 第二关·有道理（人工判断）
        self.counterparty   = "对手盘是谁"
        self.position = "FLAT"; self.entry_i = 0; self.entry_price = 0.0

    def step(self, i, ctx):
        # 返回 'LONG' / 'SHORT' / 'FLAT' / 'HOLD'
        # ctx 提供：closes/highs/lows/times, ema200, ema50, rsi14, atr14, fng_at(i), regime_at(i)
        # ⚠️ 只能用 idx <= i 的数据，禁止前视
        ...
```

然后在 `STRATEGIES` 注册表中加一行，并在 `run_research.py` 里 `STRATEGIES["MY"]()` 即可。

## 6. 数据更新要点

- K 线用 Binance 公开镜像 `data-api.binance.vision`（主站在本环境被墙）。
- 回测窗口默认 ~2 年，最后 90 天作样本外（OOS）验证。
- 若需接入资金费率 / 爆仓 / 大事件，请在可访问对应接口的环境中补充 `fetch_*` 函数。

## 7. 关键结论（真实数据，2026-11-01 跑）

「FNG-EMA 均值回归」示例策略的回测（含买入持有基准对比，分离 Beta）：

| 标的 | 样本内净收益 | 同窗口买入持有 | 超额(跑赢Beta) | 结论 |
|---|---|---|---|---|
| BTC(基准) | -7.45% | +11.90% | **-19.35%** | ❌未过（跑输大盘） |
| ETH(基准) | -0.63% | -9.70% | +9.08% | ❌未过 |
| ORDI·BRC20 | +175.59% | -89.47% | **+265.06%** | ❌OOS仅1笔，不予放行 |
| 1000SATS·BRC20 | +63.17% | -95.97% | **+159.14%** | ❌OOS仅1笔，不予放行 |

- 在 BTC/ETH 上策略**跑输**买入持有；在 BRC20（ORDI/SATS）上**大幅跑赢**，且资产自身暴跌 -89%/-96%，证明收益来自**择时而非 Beta**。
- 但 90 天 OOS 窗口在 ORDI/SATS 上仅各 1 笔交易（策略触发频率低），**无法验证** → 框架如实判「不予放行」。
- 这正是框架价值：**不美化、不编造**，跑不赢就标未过，OOS 不足就拒放行。
- **新增第四关 g4_excess（主放行门槛）**：策略须相对买入持有为正才可通过（详见 §10）。BTC 样本内 −7.45% / 买入持有 +11.90% → 超额为负 → 已被正确判负，不再被「扛得住」误导。

## 8. 历史交叉验证快照（2026-11-01；不是当前运行结果）

以下数值仅是 2026-11-01 的历史研究快照。当前 `run_research.py` 已改为每次运行动态计算交叉验证，不应将本节数字当作 2026-11-02 的最新结果。

- **粒度反转（最关键）**：ORDI 的 BRC20_RSI_MR 样本内 **4h +186.76% 但 1d −57.76%**；1000SATS **4h −32.59% 但 1d +17.68%**。两代币在 4h/1d 上结论**方向相反** → 盈利高度依赖时间粒度，是典型的**粒度/参数过拟合**信号，非可迁移 edge。
- **跨 vintage 不一致**：ORDI 三窗 OOS 净收益 +75.6% / +45.4% / −14.7%（2正1负）；SATS 三窗 +5.5% / +34.5% / −31.9%（2正1负），正负交替，稳健性不成立。
- **结论**：BRC20 上「看似惊艳」的样本内收益（ORDI +175%~+187%）**未通过交叉验证** → 框架维持「不予放行」。印证原 Prompt『反过拟合』关卡价值——单看样本内会被严重误导。
- **OOS 饥饿已缓解**：BRC20_RSI_MR 把 ORDI/SATS 的 90 天 OOS 交易数从 1 笔提升到 **10~11 笔**（原 Prompt 规定的 90 天门槛保持不变），验证可用性改善，但交叉验证仍判不可信。

### 8.1 多参数网格交叉验证（§6.5，量化过拟合）
对 `BRC20_RSI_MR` 的 `oversold × overbought` 做 25 组合笛卡尔积回测，结论（真实数据）：
- **ORDI**：最佳组合样本内 **+197.99%** 但 OOS **−12.17%**；仅 10/25 组合 OOS 盈利；离散度 +97% → **过拟合嫌疑高**。
- **SATS**：最佳组合样本内 **+61.60%** 但 OOS **−3.50%**；离散度 +174% → **过拟合嫌疑高**。
- 网格内正负号频繁切换，证明收益对参数高度敏感。单看「最佳参数暴利」会被网格打回原形。

## 9. RUNES / 资金费率 / 爆仓连接器（connectors_extra.py）

- 函数：`fetch_funding_rate`（Bybit→Binance fapi 回退）、`fetch_liquidations`（CoinGlass key / Binance allForceOrders）、`fetch_runes_top`（UniSat key / Dune key）。
- 全部 try/except + 超时包裹，**任何失败返回结构化「未知」，绝不虚构**。
- 本环境（仅放行 Binance 镜像/DefiLlama/alternative.me/mempool.space）下因**网络层封禁**必然降级为未知；在可访问环境或设置 key 后自动取数：
  - `UNISAT_API_KEY=xxx` → RUNES 代币榜
  - `DUNE_API_KEY=xxx` + `DUNE_RUNES_QUERY_ID=yyy` → Dune 查询
  - `COINGLASS_API_KEY=xxx` → 爆仓/清算聚合
- **预览/验证渲染**：在本环境运行 `NR_DEMO=1 python run_research.py` 即可查看「已获取」排版（数据为示例、非真实），用以确认连接器解析与早报渲染路径正确。

## 10. 协议升级：第四关「相对买入持有超额」主放行门槛（g4_excess）

原 Prompt 三关以绝对收益为判据，无法区分「择时 Alpha」与「高 Beta 随涨跌」。本框架**扩展**第四关（未改动原 Prompt 规定的 90 天 OOS 门槛）：
- 定义：`excess = 全窗口策略净收益 − 同窗口买入持有`。
- 通过条件：`excess >= 0`（跑赢大盘才有资格谈 edge）。
- 门优先级：样本量 → **g4 超额主门槛** → 样本内盈亏 → 反过拟合 → 第三关 → OOS。
- g4 是「必要非充分」：压「Beta 伪装 Alpha」，但压不住参数过拟合（由 §8.1 网格与反过拟合标记负责）。
- 详见 `设计文档.md` §10。

## 11. 三项收尾任务状态（2026-11-01）

| 任务 | 状态 | 说明 |
|---|---|---|
| ① 配置 key 启用 §七 真实数据 | ✅ 就绪 | 连接器「配 key+可达即真用」；本环境受防火墙所限无法实测，解析/渲染经 `NR_DEMO=1` 演示验证 |
| ② ORDI/SATS 多参数网格交叉验证 | ✅ 完成 | `grid_search`+`summarize_grid` 落地，量化过拟合（§6.5/§8.1） |
| ③ 超额收益升为主放行指标 | ✅ 完成 | 新增 g4_excess（§10），BTC 等跑输大盘已被正确判负 |

> 免责声明：示例/教学，非投资建议。据此实盘盈亏自负。


## 12. 交易指挥中心 V1（模拟账户）

- 新增 dashboard/trading.html，保留原研究仪表盘，并从首页进入交易工作台。
- 实时行情：Binance 公共 REST + WebSocket，覆盖 BTC、ETH、ORDI、1000SATS 现货。
- 盘口与逐笔：展示公开盘口和实时成交流；市价模拟单按可见盘口深度逐档计算成交均价，盘口深度不足时拒绝模拟成交。
- 模拟账户：初始 10,000 USDT；本地浏览器持久化；仅现货多头，不支持杠杆、裸卖空、钱包连接或真实下单。
- 限价单：只在公开盘口跨价且可见深度足够时模拟成交；不模拟真实交易所队列优先级。
- 风险闸门：单笔不超过净值 10%、总敞口不超过 40%、单日亏损 3% 熔断、账户回撤 10% 熔断；卖出操作保留以便降低风险。
- 策略放行：直接读取 dashboard/data/research.json；当前没有通过门禁的策略时明确显示「未放行」，不将回测收益包装成实盘能力。
- 3D 市场宇宙：Three.js 节点仅用于资产态势展示，不代表真实资金流或相关性。
- 本地预览：cd dashboard && python -m http.server 8765，然后访问 http://localhost:8765/trading.html。
- 质量检查：npm test；python -m unittest discover -s tests -p "test_*.py"。

当前模拟账户数据仅保存在打开终端的浏览器 localStorage，清除浏览器数据会清空账户；跨设备同步和服务端账户账本属于下一阶段。此版本不连接真实交易所账户，不接受交易 API Key。


## 13. AI Provider Center 与六角色研究流程

- `dashboard/trading.html` 首屏顶部新增独立可见的 AI Provider Center（锚点 `#aiProviderCenter`），从首页也可直接点击“AI API 配置”；包括 MiniMax M3 / Qwen Model Studio API 输入、连接测试、普通 AI 分析、六 Agent 研究流程和独立模拟往返自检。
- `functions/api/ai/chat.js` 是 Cloudflare Pages 同站 API；`functions/_lib/ai-core.mjs` 负责校验和转发。
- API Key 仅在当前页面内存中保留，按用户点击发起请求时经 HTTPS 发送到同站函数，再转发至所选模型服务商；应用不写入 localStorage、Cookie、Git 或日志。刷新页面后需要重新输入。
- MiniMax：模型 `MiniMax-M3`；中国站 `https://api.minimaxi.com/v1`、国际站 `https://api.minimax.io/v1`，API Key 与区域必须匹配。
- Qwen：使用 Model Studio 通用 API Key（`sk-`）和与密钥同区域的 Workspace ID；默认 `qwen3-coder-next`，同时支持 `qwen3-coder-plus`、`qwen3.8-max`、`qwen3.7-plus`、`qwen3.6-plus`。
- **不要把 Qwen Coding Plan 的 `sk-sp-` 密钥填入网页**。该套餐仅供 Qwen Code 等交互式编程工具使用，不用于本应用后端。
- 六角色顺序：SPOTTER → PRIOR → EDGE → KELLY → TAKER → CLOSER。SPOTTER/PRIOR/EDGE/CLOSER 由模型分别调用；KELLY 的计算函数采用 95% Wilson 胜率下界 + 1/4 Kelly + 10% 上限；但 Agent API 目前不接受客户端提交的回测统计，因服务端可信研究账本尚未建成，故当前 KELLY 恒为 0、TAKER 恒阻断。TAKER 永远不会自动创建模拟单或真实订单。
- AI 只生成研究意见，不决定策略是否放行，不生成真实交易指令。研究门禁仍由程序计算。
- 收益研究与模拟验收路线见 `盈利研究计划.md`。

### 质量测试

```bash
npm test
npm run test:e2e
python -m unittest discover -s tests -p "test_*.py"
```

浏览器 E2E 使用 Playwright + 模拟 Binance 公共行情响应，验证页面行情加载、盘口驱动的模拟成交、单笔风险拒单、MiniMax/Qwen 输入界面和密钥不落地。该测试不替代用户输入真实 API Key 后的供应商连通性测试。

## 14. 六层 AI Quant Trading OS 架构与当前审计

- 架构审计：`docs/AI_QUANT_TRADING_OS_ARCHITECTURE.md`
- JEV React 19 / Vite / Three.js 集成合同：`docs/JEV_TRADING_DESK_INTEGRATION.md`
- 当前严格 Walk-forward：每个 90 天 fold 只用验证开始前的数据选择参数，再用独立策略实例验证；训练期无正 edge 时不强行选参。
- 回测风险质量新增：胜率 95% Wilson 区间、Expectancy、Profit Factor、每笔 Sharpe/Sortino（不年化）、交易收益 bootstrap Monte Carlo（1,000 次）和额外每边 0/5/10/20/50 bps 滑点敏感性；Monte Carlo 不模拟盘口路径/序列相关，不能当作收益预测。
- CRC20/LEAF：新增 `fetch_crc20_status`、`fetch_crc20_stats`、`fetch_crc20_history`、`fetch_crc20_market_snapshot`；marketplace sale 与 AXBT/LEAF pool swap 分开，不把它们合成一个虚假的 latest_trade。
- CRC20 公开 API 没有可验证的完整订单簿，因此 best bid/ask、6h VWAP、统一 latest_trade 保持 unknown；需要和 `https://crc.garden/activity`、Bitcoin 区块/交易证据交叉核验。
- 3D 市场宇宙：新增 Binance 90 天 4h 收益相关性连线；明确标记为价格相关性，不伪装成资金流。真实资金流边仍待接入链上/DEX 成交证据。
- 当前分支仍是 Night Researcher 预览原型；JEV 本地 React 前端、Provider Center DPAPI、4779 后端和六个 React 页面尚未真正集成。必须在可访问的 JEV 源码上完成，不宣称已完成。

