/* research.js — 研究结论兜底常量（仅在 data/research.json 加载失败时回退使用）
   真实数据由 run_research.py 生成 research.json 并经前端实时拉取；
   此处保留最近一次快照，确保离线/部署异常时面板仍有内容。 */
const RESEARCH_FALLBACK = {
  meta: {
    date: "2026-11-01",
    window: "730 天回测窗口 + 90 天样本外(OOS)",
    note: "所有数值来自真实公开数据回测；策略均标注「示例/教学，非投资建议」。",
  },
  // 第四关协议
  gates: {
    g4: "第四关·超额主门槛(g4)：样本内净收益须跑赢同窗口「买入持有」（相对买入持有 ≥ 0），否则不予放行。",
    oos90: "原 Prompt 规定「强制留最近 3 个月(90天)验证」的 OOS 门槛保持不变，未擅自修改协议。",
  },
  // 策略卡片（总表）
  cards: [
    { sym: "BTC", tag: "基准", strat: "FNG_EMA_MR", inSample: -7.45, excess: -17.34, oos: 2.57, mdd: 30.09, trades: 54, pass: false, reason: "g4 超额为负，跑输大盘" },
    { sym: "ETH", tag: "基准", strat: "FNG_EMA_MR", inSample: -0.63, excess: 9.24, oos: 0.51, mdd: 37.78, trades: 57, pass: false, reason: "样本内净收益为负" },
    { sym: "ORDI", tag: "BRC20", strat: "FNG_EMA_MR", inSample: 175.59, excess: 293.06, oos: 10.23, mdd: 27.47, trades: 53, pass: false, reason: "OOS 仅 1 笔，无法验证" },
    { sym: "1000SATS", tag: "BRC20", strat: "FNG_EMA_MR", inSample: 63.31, excess: 152.84, oos: -3.90, mdd: 25.97, trades: 42, pass: false, reason: "OOS 为负" },
    { sym: "ORDI", tag: "BRC20", strat: "BRC20_RSI_MR", inSample: 173.85, excess: 222.81, oos: -14.72, mdd: 64.98, trades: 102, pass: false, reason: "反过拟合标记可疑 / OOS 为负" },
    { sym: "1000SATS", tag: "BRC20", strat: "BRC20_RSI_MR", inSample: -17.23, excess: 83.19, oos: 5.46, mdd: 80.11, trades: 99, pass: false, reason: "样本内净收益为负" },
  ],
  // 交叉验证
  crossValidation: {
    grainFlip: [
      { sym: "ORDI", strat: "BRC20_RSI_MR", h4: 186.76, d1: -57.76 },
      { sym: "1000SATS", strat: "BRC20_RSI_MR", h4: -32.59, d1: 17.68 },
    ],
    vintage: [
      { sym: "ORDI", wins: ["+75.6%", "+45.4%", "-14.7%"], pos: 2, neg: 1 },
      { sym: "1000SATS", wins: ["+5.5%", "+34.5%", "-31.9%"], pos: 2, neg: 1 },
    ],
    conclusion: "BRC20「看似惊艳」的样本内收益（ORDI +175%~+187%、SATS 各有盈亏）未通过跨资产/跨周期/跨 vintage 交叉验证 → 框架维持「不予放行」。单看样本内会被严重误导。",
  },
  // 多参数网格交叉验证（oversold × overbought，5×5=25 组合，样本内/OOS）
  grid: {
    axes: { oversold: [22, 26, 30, 35, 40], overbought: [60, 65, 70, 75, 80] },
    ordi: {
      inProfit: "14/25 (56%)", oosProfit: "10/25 (40%)", dispersion: "+97%",
      best: { os: 26, ob: 70, inSample: 197.99, oos: -12.17, oosTrades: 8 },
      matrix: [
        ["+47%/-1%", "+67%/-29%", "+114%/-20%", "-7%/-3%", "-28%/-13%"],
        ["+102%/+8%", "+133%/-23%", "+198%/-12%", "+30%/+6%", "+1%/-5%"],
        ["+89%/+5%", "+114%/-25%", "+174%/-15%", "+19%/+3%", "-8%/-8%"],
        ["-6%/+13%", "+6%/-19%", "+36%/-8%", "-41%/+10%", "-54%/-1%"],
        ["-44%/+39%", "-40%/-1%", "-24%/+12%", "-67%/+34%", "-74%/+21%"],
      ],
      verdict: "过拟合嫌疑高 ❌（最佳 OOS 未盈利 / 离散度 +97% / 仅 10/25 组合 OOS 盈利）",
    },
    sats: {
      inProfit: "5/25 (20%)", oosProfit: "19/25 (76%)", dispersion: "+174%",
      best: { os: 30, ob: 75, inSample: 61.60, oos: -3.50, oosTrades: 9 },
      matrix: [
        ["+4%/+14%", "-42%/+10%", "-24%/+14%", "+48%/+4%", "-73%/+30%"],
        ["-16%/+28%", "-53%/+23%", "-38%/+27%", "+21%/+16%", "-78%/+45%"],
        ["+13%/+6%", "-37%/+2%", "-17%/+5%", "+62%/-4%", "-70%/+20%"],
        ["-49%/+8%", "-72%/+4%", "-62%/+7%", "-28%/-2%", "-87%/+22%"],
        ["-62%/-4%", "-79%/-8%", "-72%/-5%", "-45%/-13%", "-90%/+8%"],
      ],
      verdict: "过拟合嫌疑高 ❌（最佳 OOS 未盈利 / 离散度 +174% / 样本内仅 5/25 组合盈利）",
    },
  },
  // BRC20/RUNES 生态监测静态快照（实时折线由前端拉取）
  ecosystem: {
    lastDayFee: 95.8, avg30: 78.2, avg90: 78.9, avg365: 65.1,
    mempoolNow: "1 sat/vB（极闲）",
    eras: [
      { label: "前BRC20", sub: "2018-03~2023-02", value: 9.4, days: 1801 },
      { label: "BRC20", sub: "2023-03~2024-04", value: 30.1, days: 416 },
      { label: "RUNES", sub: "2024-04~今", value: 65.1, days: 925 },
    ],
  },
};
