/* app.js — 夜班交易研究员 实时仪表盘（纯前端，浏览器直连公开 API）
   合规：仅展示研究/行情，不写下单代码、不触发交易、不爬 X、不给买卖建议。 */
"use strict";

const SYMBOLS = [
  { sym: "BTCUSDT", name: "BTC" },
  { sym: "ETHUSDT", name: "ETH" },
  { sym: "ORDIUSDT", name: "ORDI" },
  { sym: "1000SATSUSDT", name: "1000SATS" },
];
const INTERVALS = ["1m", "15m", "1h", "4h", "1d"];

const state = {
  sym: "BTCUSDT",
  interval: "4h",
  lastTicker: 0, lastKline: 0, lastMacro: 0,
  klines: null, feesPts: null,
  auto: true, period: 15000,
  researchData: null, researchFallback: false,
  researchAuto: true, researchPeriod: 300000,
};

/* ---------- 轻量 fetch（带内存缓存 + 降级） ---------- */
const API = {
  _c: {},
  async getJSON(url, ttl) {
    const e = this._c[url];
    if (e && (Date.now() - e.t) < (ttl || 300000)) return e.d;
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    this._c[url] = { t: Date.now(), d };
    return d;
  },
};

async function fetchTicker(sym) {
  const d = await API.getJSON(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${sym}`, 20000);
  return { price: parseFloat(d.lastPrice), chg: parseFloat(d.priceChangePercent) };
}
async function fetchKlines(sym, interval, limit) {
  const d = await API.getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`, 30000);
  return d.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
}
async function fetchFng() {
  const d = await API.getJSON("https://api.alternative.me/fng/?limit=1", 300000);
  const p = d.data[0];
  return { value: +p.value, label: p.value_classification };
}
async function fetchStablecoin() {
  const d = await API.getJSON("https://stablecoins.llama.fi/stablecoins?includePrices=true", 3600000);
  let cur = 0, prev = 0;
  (d.peggedAssets || []).forEach(a => {
    cur += (a.circulating && a.circulating.peggedUSD) || 0;
    const pd = a.circulatingPrevDay; prev += (pd && pd.peggedUSD) || 0;
  });
  return { cur, prev };
}
async function fetchFees() {
  const d = await API.getJSON("https://api.llama.fi/overview/fees?chain=Bitcoin", 3600000);
  const c = d.totalDataChart || [];
  return c.map(p => ({ x: new Date(p[0] * 1000).toISOString().slice(0, 10), y: p[1] }));
}
async function fetchMempool() {
  const d = await API.getJSON("https://mempool.space/api/v1/fees/recommended", 60000);
  return d; // {fastestFee, halfHourFee, hourFee, minimumFee}
}
// BTC 永续资金费率（Binance 期货镜像，浏览器直连；沙箱可能 502，但公网可用，失败优雅降级）
async function fetchFundingRate(sym) {
  const d = await API.getJSON(`https://fapi.binance.vision/fapi/v1/premiumIndex?symbol=${sym}`, 120000);
  const r = parseFloat(d.lastFundingRate);
  if (isNaN(r)) throw new Error("bad fr");
  return r; // 如 0.0001 = 0.01%
}

/* ---------- 指标 ---------- */
function ema(period, closes) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = 0; for (let i = 0; i < period; i++) sum += closes[i];
  let prev = sum / period; out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) { prev = closes[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function rsi(period, closes) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  let aG = gain / period, aL = loss / period;
  out[period] = 100 - 100 / (1 + (aL === 0 ? 100 : aG / aL));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1], g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    aG = (aG * (period - 1) + g) / period; aL = (aL * (period - 1) + l) / period;
    const rs = aL === 0 ? 100 : aG / aL;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

/* ---------- 渲染：实时快照卡片 ---------- */
function setCard(name, { price, chg, sub }) {
  const card = document.querySelector(`.snap[data-sym="${name}"]`);
  if (!card) return;
  const priceEl = card.querySelector(".price");
  const chgEl = card.querySelector(".chg");
  priceEl.textContent = price == null ? "—" : NRCharts.fmtPrice(price);
  if (chg == null) { chgEl.textContent = "—"; chgEl.className = "chg"; }
  else {
    const up = chg >= 0;
    chgEl.textContent = (up ? "▲ +" : "▼ ") + chg.toFixed(2) + "%";
    chgEl.className = "chg " + (up ? "up" : "down");
  }
  if (sub != null) card.querySelector(".sub").textContent = sub;
}

async function refreshTickers() {
  for (const s of SYMBOLS) {
    try {
      const t = await fetchTicker(s.sym);
      setCard(s.name, { price: t.price, chg: t.chg });
    } catch (e) {
      setCard(s.name, { price: null, chg: null });
    }
  }
}

/* ---------- 渲染：K线 + 指标 ---------- */
async function refreshKline() {
  try {
    const limit = 400;
    const kl = await fetchKlines(state.sym, state.interval, limit);
    state.klines = kl;
    const closes = kl.map(k => k.c);
    const e = ema(200, closes);
    const r = rsi(14, closes);
    const name = SYMBOLS.find(s => s.sym === state.sym).name;
    NRCharts.candles(document.getElementById("klineMain"), { klines: kl, ema: e, symbol: `${name} · ${state.interval} · 蜡烛+EMA200` });
    NRCharts.rsi(document.getElementById("klineRsi"), { rsi: r });
    NRCharts.volume(document.getElementById("klineVol"), { klines: kl });
  } catch (e) {
    console.warn("kline fail", e);
  }
}

/* ---------- 渲染：宏观 + 生态 ---------- */
function fmtB(v) { return "$" + (v / 1e9).toFixed(1) + "B"; }
// 通用 USD 金额格式化（处理 None / 大数 / 小数）
function fmtUsd(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  return "$" + n.toFixed(4);
}

async function refreshMacro() {
  // 恐贪
  try {
    const f = await fetchFng();
    const el = document.querySelector('.snap[data-sym="FNG"]');
    el.querySelector(".price").textContent = String(f.value);
    el.querySelector(".chg").textContent = f.label;
    el.querySelector(".chg").className = "chg " + (f.value >= 50 ? "up" : "down");
  } catch (e) { console.warn("fng fail", e); }
  // 稳定币
  try {
    const s = await fetchStablecoin();
    const d = s.cur - s.prev;
    const pct = s.prev ? (d / s.prev * 100) : 0;
    setCard("STABLE", { price: s.cur / 1e9, chg: null, sub: `较昨日 ${(d >= 0 ? "+" : "") + fmtB(d)} (${(pct >= 0 ? "+" : "") + pct.toFixed(2)}%)` });
    document.querySelector('.snap[data-sym="STABLE"] .price').textContent = fmtB(s.cur);
  } catch (e) { console.warn("stable fail", e); }
  // mempool
  try {
    const m = await fetchMempool();
    setCard("MEMPOOL", { price: m.fastestFee, chg: null, sub: `半时${m.hourFee} · 最低${m.minimumFee} sat/vB` });
  } catch (e) { console.warn("mempool fail", e); }
  // BTC 永续资金费率（每 8h 结算）
  try {
    const fr = await fetchFundingRate("BTCUSDT");
    const pct = fr * 100;
    const card = document.querySelector('.snap[data-sym="FR"]');
    if (card) {
      const pe = card.querySelector(".price");
      const ce = card.querySelector(".chg");
      pe.textContent = (pct >= 0 ? "+" : "") + pct.toFixed(4) + "%";
      ce.textContent = "每 8h";
      ce.className = "chg " + (pct >= 0 ? "up" : "down");
      card.querySelector(".sub").textContent = "Binance 永续 · 多空费";
    }
  } catch (e) {
    console.warn("funding fail", e);
    const card = document.querySelector('.snap[data-sym="FR"]');
    if (card) {
      card.querySelector(".price").textContent = "未知";
      card.querySelector(".chg").textContent = "接口不可达";
      card.querySelector(".chg").className = "chg";
    }
  }
  // BTC 手续费（近一日），从 fees 序列末点
  try {
    const pts = await fetchFees();
    state.feesPts = pts;
    const last = pts[pts.length - 1];
    setCard("FEES", { price: last.y / 1e6, chg: null, sub: `近30日均值 ${avgLast(pts, 30) / 1e6 | 0}M` });
    document.querySelector('.snap[data-sym="FEES"] .price').textContent = "$" + (last.y / 1e6).toFixed(1) + "M";
    // 折线（最近 365 天）
    NRCharts.line(document.getElementById("feeLine"), {
      points: pts.slice(-365), color: "#f0b90b",
      fmt: v => "$" + (v / 1e6).toFixed(0) + "M",
    });
  } catch (e) { console.warn("fees fail", e); }
}
function avgLast(pts, n) {
  const s = pts.slice(-n); return s.reduce((a, p) => a + p.y, 0) / s.length;
}

/* ---------- 研究面板（实时 JSON 驱动） ---------- */
async function loadResearch() {
  try {
    const r = await fetch("data/research.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    state.researchData = await r.json();
    state.researchFallback = false;
  } catch (e) {
    console.warn("research.json 加载失败，使用兜底快照：", e);
    state.researchData = RESEARCH_FALLBACK;
    state.researchFallback = true;
  }
  renderEraBars();
  renderResearchPanel();
  const ts = document.getElementById("researchTs");
  if (ts) ts.textContent = state.researchFallback
    ? "（兜底快照，JSON 加载失败）"
    : "生成于 " + (state.researchData.meta && state.researchData.meta.generatedAt || "—");
}

function renderEraBars() {
  const eras = (state.researchData && state.researchData.ecosystem && state.researchData.ecosystem.eras) || [];
  if (eras.length) {
    NRCharts.bars(document.getElementById("eraBars"), { bars: eras.map(e => ({ label: e.label, sub: e.sub, value: e.value })) });
  }
}

function renderResearchPanel() {
  const R = state.researchData;
  if (!R) { document.getElementById("research").innerHTML = "<p class='muted'>研究结论加载中…</p>"; return; }
  let h = "";
  h += `<h3>策略卡片总表 <span class="muted">（${R.meta && R.meta.date || ""} 真实回测）</span></h3>`;
  h += `<table class="tbl"><thead><tr><th>标的</th><th>策略</th><th>样本内</th><th>相对买入持有(g4)</th><th>OOS</th><th>最大回撤</th><th>笔数</th><th>结论</th></tr></thead><tbody>`;
  (R.cards || []).forEach(c => {
    const cls = c.pass ? "ok" : "bad";
    const ins = (c.inSample == null ? "—" : (c.inSample >= 0 ? "+" : "") + c.inSample + "%");
    const ex = (c.excess == null ? "—" : (c.excess >= 0 ? "+" : "") + c.excess + "%");
    const oos = (c.oos == null ? "—" : (c.oos >= 0 ? "+" : "") + c.oos + "%");
    h += `<tr><td><b>${c.sym}</b> <span class="tag">${c.tag}</span></td><td>${c.strat}</td>` +
      `<td class="${c.inSample >= 0 ? "up" : "down"}">${ins}</td>` +
      `<td class="${c.excess >= 0 ? "up" : "down"}">${ex}</td>` +
      `<td>${oos}</td><td class="down">${c.mdd}%</td><td>${c.trades}</td>` +
      `<td class="${cls}">${c.pass ? "✅存活" : "❌" + c.reason}</td></tr>`;
  });
  h += `</tbody></table>`;

  h += `<div class="callout"><b>第四关·超额主门槛 (g4)：</b>${R.gates.g4}<br><b>OOS 协议：</b>${R.gates.oos90}</div>`;

  const cv = R.crossValidation || {};
  h += `<h3>交叉验证（压制单资产过拟合嫌疑）</h3>`;
  h += `<p class="muted">粒度反转：同一策略在 4h 与 1d 上样本内结论方向相反 → 参数/粒度过拟合信号。</p>`;
  h += `<table class="tbl"><thead><tr><th>标的</th><th>策略</th><th>4h 样本内</th><th>1d 样本内</th><th>方向</th></tr></thead><tbody>`;
  (cv.grainFlip || []).forEach(r => {
    const flip = (r.h4 >= 0) !== (r.d1 >= 0);
    h += `<tr><td><b>${r.sym}</b></td><td>${r.strat}</td>` +
      `<td class="${r.h4 >= 0 ? "up" : "down"}">${(r.h4 >= 0 ? "+" : "") + r.h4}%</td>` +
      `<td class="${r.d1 >= 0 ? "up" : "down"}">${(r.d1 >= 0 ? "+" : "") + r.d1}%</td>` +
      `<td class="bad">${flip ? "反转 ⚠" : "一致"}</td></tr>`;
  });
  h += `</tbody></table>`;
  if (cv.vintage) h += `<p class="muted">跨 vintage OOS（BRC20_RSI_MR）：` +
    cv.vintage.map(v => `${v.sym} [${v.wins.join(" / ")}]（${v.pos}正${v.neg}负）`).join("；") + `</p>`;
  if (cv.conclusion) h += `<div class="callout bad">${cv.conclusion}</div>`;

  const g = R.grid || {};
  h += `<h3>多参数网格交叉验证（量化过拟合 · oversold × overbought，25 组合）</h3>`;
  ["ordi", "sats"].forEach(k => {
    const G = g[k]; if (!G) return;
    const label = k === "ordi" ? "ORDI·BRC20" : "1000SATS·BRC20";
    h += `<h4>${label}</h4>`;
    h += `<p class="muted">样本内盈利 ${G.inProfit} ｜ OOS 盈利 ${G.oosProfit} ｜ 离散度 ${G.dispersion} ｜ 最佳(oversold=${G.best.os}, overbought=${G.best.ob}) 样本内 ${G.best.inSample}% / OOS ${G.best.oos}%</p>`;
    h += `<table class="grid"><thead><tr><th>oversold\\overbought</th>${g.axes.overbought.map(o => `<th>${o}</th>`).join("")}</tr></thead><tbody>`;
    G.matrix.forEach((row, i) => {
      h += `<tr><th>${g.axes.oversold[i]}</th>` + row.map(c => {
        const [ins, oos] = c.split("/");
        const insBad = ins.trim().startsWith("-") || ins.trim() === "—";
        const oosBad = oos.trim().startsWith("-") || oos.trim() === "—";
        return `<td><span class="${insBad ? "down" : "up"}">${ins}</span><br><span class="${oosBad ? "down" : "up"}">${oos}</span></td>`;
      }).join("") + `</tr>`;
    });
    h += `</tbody></table>`;
    h += `<div class="callout bad">${G.verdict}</div>`;
  });
  h += `<p class="muted">表中「样本内 / OOS」；正负号在网格内频繁切换即说明收益对参数高度敏感、稳定性差。</p>`;

  // ============ §七 补充数据（资金费率 / 爆仓 / RUNES，配 key 自动启用）============
  const sup = R.supplementary || {};
  h += `<h3>补充数据 · 永续资金费率 / 爆仓 / RUNES <span class="muted">（配 key 自动启用）</span></h3>`;
  const fr = sup.fundingRate || {};
  if (fr.ok && fr.rate != null) {
    const r = fr.rate * 100;
    h += `<p>💱 <b>BTC 永续资金费率</b>：<span class="${r >= 0 ? "up" : "down"}">${(r >= 0 ? "+" : "") + r.toFixed(4)}%</span> `
       + `<span class="muted">（来源 ${fr.source || "—"}${fr.demo ? "·演示非真实" : ""}）</span></p>`;
  } else {
    h += `<p class="muted">💱 资金费率：构建环境不可达（线上浏览器实时卡已覆盖 fapi.binance.vision）。${fr.reason ? " " + fr.reason : ""}</p>`;
  }
  const liq = sup.liquidations || {};
  h += `<p class="muted">🔥 爆仓/强平：${liq.ok ? ("已获取（" + (liq.source || "—") + (liq.demo ? "·演示非真实" : "") + "）") : "未知（需 COINGLASS_API_KEY）"}</p>`;
  const rn = sup.runes || {};
  if (rn.ok && rn.tokens && rn.tokens.length) {
    h += `<h4>🪙 RUNES 代币榜 <span class="muted">（${rn.source || ""}${rn.demo ? "·演示非真实" : ""}）</span></h4>`;
    h += `<table class="tbl"><thead><tr><th>符文</th><th>价格(USD)</th><th>24h量</th><th>市值</th></tr></thead><tbody>`;
    rn.tokens.forEach(t => {
      h += `<tr><td><b>${t.symbol}</b>${t.name ? ` <span class="tag">${t.name}</span>` : ""}</td>`
        + `<td>${fmtUsd(t.priceUsd)}</td><td>${fmtUsd(t.volume24h)}</td><td>${fmtUsd(t.mcap)}</td></tr>`;
    });
    h += `</tbody></table>`;
  } else {
    h += `<p class="muted">🪙 RUNES 代币榜：未知（需 <b>UNISAT_API_KEY</b> 或 <b>DUNE_API_KEY</b>+<b>DUNE_RUNES_QUERY_ID</b>；`
       + `构建环境网络层封禁，标未知不虚构）。${rn.reason ? "<br>" + rn.reason : ""}</p>`;
  }

  document.getElementById("research").innerHTML = h;
}

/* ---------- 时钟与循环 ---------- */
function updateClock() {
  const el = document.getElementById("lastUpdate");
  if (el) el.textContent = new Date().toLocaleString("zh-CN", { hour12: false });
}

async function tick() {
  const now = Date.now();
  if (now - state.lastTicker > 15000) { await refreshTickers(); state.lastTicker = now; }
  if (now - state.lastKline > 30000) { await refreshKline(); state.lastKline = now; }
  if (now - state.lastMacro > 300000) { await refreshMacro(); state.lastMacro = now; }
  updateClock();
}

/* ---------- 初始化 ---------- */
function buildTabs() {
  const symTabs = document.getElementById("symTabs");
  SYMBOLS.forEach((s, i) => {
    const b = document.createElement("button");
    b.textContent = s.name;
    b.className = "tab" + (i === 0 ? " active" : "");
    b.onclick = () => {
      state.sym = s.sym;
      [...symTabs.children].forEach(c => c.classList.remove("active"));
      b.classList.add("active");
      refreshKline();
    };
    symTabs.appendChild(b);
  });
  const intTabs = document.getElementById("intTabs");
  INTERVALS.forEach((iv, i) => {
    const b = document.createElement("button");
    b.textContent = iv;
    b.className = "tab" + (iv === state.interval ? " active" : "");
    b.onclick = () => {
      state.interval = iv;
      [...intTabs.children].forEach(c => c.classList.remove("active"));
      b.classList.add("active");
      refreshKline();
    };
    intTabs.appendChild(b);
  });
}

function bindControls() {
  const autoBtn = document.getElementById("autoBtn");
  autoBtn.onclick = () => {
    state.auto = !state.auto;
    autoBtn.textContent = state.auto ? "⏸ 自动刷新：开" : "▶ 自动刷新：关";
    autoBtn.classList.toggle("off", !state.auto);
  };
  document.getElementById("refreshBtn").onclick = () => tick();
  const sel = document.getElementById("periodSel");
  sel.onchange = () => { state.period = parseInt(sel.value, 10); };
  // 研究结论刷新控制
  const rbtn = document.getElementById("researchRefresh");
  if (rbtn) rbtn.onclick = () => loadResearch();
  const rauto = document.getElementById("researchAuto");
  if (rauto) rauto.onchange = () => { state.researchAuto = rauto.checked; if (state.researchAuto) loadResearch(); };
  window.addEventListener("resize", () => {
    if (state.klines) {
      const closes = state.klines.map(k => k.c);
      NRCharts.candles(document.getElementById("klineMain"), { klines: state.klines, ema: ema(200, closes), symbol: "" });
      NRCharts.rsi(document.getElementById("klineRsi"), { rsi: rsi(14, closes) });
      NRCharts.volume(document.getElementById("klineVol"), { klines: state.klines });
    }
    if (state.feesPts) NRCharts.line(document.getElementById("feeLine"), { points: state.feesPts.slice(-365), color: "#f0b90b", fmt: v => "$" + (v / 1e6).toFixed(0) + "M" });
    const eras = (state.researchData && state.researchData.ecosystem && state.researchData.ecosystem.eras) || [];
    if (eras.length) renderEraBars();
  });
}

function main() {
  buildTabs();
  bindControls();
  loadResearch();   // 研究结论 JSON（实时刷新数据源）
  tick();
  setInterval(() => { if (state.auto) tick(); }, state.period);
  // 研究结论自动刷新（默认 5 分钟；重跑 run_research.py 后浏览器自动拾取新数据）
  setInterval(() => { if (state.researchAuto) loadResearch(); }, state.researchPeriod);
}
document.addEventListener("DOMContentLoaded", main);
