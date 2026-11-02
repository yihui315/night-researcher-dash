/* Night Researcher Trading Desk V1 — public market data + local paper execution only. */
"use strict";
(function () {
  const API = "https://data-api.binance.vision/api/v3";
  const ASSETS = [
    { symbol: "BTCUSDT", label: "BTC" }, { symbol: "ETHUSDT", label: "ETH" },
    { symbol: "ORDIUSDT", label: "ORDI" }, { symbol: "1000SATSUSDT", label: "1000SATS" }
  ];
  const INTERVALS = { "1m": 60, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  const state = { symbol: "BTCUSDT", interval: "4h", side: "BUY", tickers: {}, book: { bids: [], asks: [] }, bookUpdatedAt: 0, klines: [], trades: [], socket: null, socketReady: false, reconnectTimer: null, socketGeneration: 0, depthBook: window.NRDepthBook.create(20), depthBuffer: [], depthSynced: false, depthResyncing: false, chart: null, candleSeries: null, lastBar: null, account: window.NRPaper.loadAccount(), marks: {}, restTimer: null, ledger: window.NRPaperLedger.createClient() };
  const $ = id => document.getElementById(id);
  const money = n => Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n, d) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d == null ? 6 : d });
  const priceFmt = n => {
    const v = Number(n || 0); if (!v) return "—";
    return v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v >= 1 ? v.toFixed(4) : v >= 0.01 ? v.toFixed(6) : v.toFixed(8);
  };
  const assetName = symbol => (ASSETS.find(a => a.symbol === symbol) || { label: symbol }).label;
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  const colorPnl = (el, value) => { if (!el) return; el.classList.toggle("positive", value > 0); el.classList.toggle("negative", value < 0); };
  async function getJSON(url) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 9000);
    try { const r = await fetch(url, { signal: controller.signal, cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
    finally { clearTimeout(timeout); }
  }
  function marks() { const m = {}; Object.keys(state.tickers).forEach(s => { m[s] = state.tickers[s].price; }); return m; }
  function setLedgerStatus(message, mode) {
    const el = $("paperLedgerStatus");
    if (!el) return;
    el.textContent = message;
    el.dataset.state = mode || "neutral";
    el.classList.toggle("warning", mode === "warning");
    el.classList.toggle("safe", mode === "ready");
  }
  function persist(reason) {
    state.account.updatedAt = new Date().toISOString();
    window.NRPaper.saveAccount(state.account);
    renderAccount();
    if (!state.ledger) return;
    state.ledger.appendSnapshot(state.account, marks(), reason || "state-change")
      .then(result => {
        if (result && result.ok) setLedgerStatus("服务端备份已同步", "ready");
        else setLedgerStatus("仅本地 · 服务端账本未配置", "warning");
      })
      .catch(() => setLedgerStatus("本地缓存 · 云端同步失败", "warning"));
  }
  async function syncPaperLedger() {
    setLedgerStatus("服务端账本连接中", "neutral");
    try {
      const session = await state.ledger.startSession();
      if (!session.available) {
        setLedgerStatus("仅本地 · 服务端账本未配置", "warning");
        return;
      }
      const remote = await state.ledger.latestSnapshot();
      if (!remote) {
        const result = await state.ledger.appendSnapshot(state.account, marks(), "session-bootstrap");
        setLedgerStatus(result && result.ok ? "服务端备份已同步" : "仅本地 · 服务端账本未配置", result && result.ok ? "ready" : "warning");
        return;
      }
      const localTime = Date.parse(state.account.updatedAt || state.account.createdAt || 0) || 0;
      const remoteTime = Date.parse(remote.account.updatedAt || remote.account.createdAt || remote.event.createdAt || 0) || 0;
      if (remoteTime > localTime) {
        state.account = remote.account;
        window.NRPaper.saveAccount(state.account);
        renderAccount();
        setLedgerStatus("已从服务端恢复模拟账户", "ready");
      } else if (localTime > remoteTime) {
        const result = await state.ledger.appendSnapshot(state.account, marks(), "local-newer-than-server");
        setLedgerStatus(result && result.ok ? "本地状态已备份" : "仅本地 · 云端同步失败", result && result.ok ? "ready" : "warning");
      } else {
        setLedgerStatus("服务端备份已同步", "ready");
      }
    } catch (_) {
      setLedgerStatus("本地缓存 · 云端同步失败", "warning");
    }
  }
  function setConnection(text, offline) {
    const el = $("connectionStatus"); if (!el) return;
    el.textContent = text; el.classList.toggle("offline", !!offline);
  }
  function updateTicker(symbol, data) {
    const prior = state.tickers[symbol] || {};
    const item = { price: Number(data.price), change: Number(data.change || 0), quoteVolume: Number(data.quoteVolume || prior.quoteVolume || 0), updatedAt: Date.now() };
    state.tickers[symbol] = item; state.marks[symbol] = item.price;
    setText("ticker-" + symbol, priceFmt(item.price));
    const changeEl = $("change-" + symbol);
    if (changeEl) { changeEl.textContent = (item.change >= 0 ? "+" : "") + item.change.toFixed(2) + "% · 24h"; changeEl.className = item.change >= 0 ? "positive" : "negative"; }
    if (symbol === state.symbol) {
      setText("selectedPrice", priceFmt(item.price));
      setText("selectedChange", (item.change >= 0 ? "+" : "") + item.change.toFixed(2) + "%");
      colorPnl($("selectedChange"), item.change);
      setText("selectedVolume", "24h 成交额 " + money(item.quoteVolume));
      updateLiveCandle(item.price);
      updateEstimate();
    }
    if (window.NRMarket3D) window.NRMarket3D.updateAssets(state.tickers);
    renderAccount();
  }
  async function refreshSnapshot() {
    await Promise.all(ASSETS.map(async a => {
      try {
        const d = await getJSON(API + "/ticker/24hr?symbol=" + a.symbol);
        updateTicker(a.symbol, { price: d.lastPrice, change: d.priceChangePercent, quoteVolume: d.quoteVolume });
      } catch (_) { setText("change-" + a.symbol, "行情暂不可达"); }
    }));
    setText("lastUpdate", "更新 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }));
  }
  async function refreshDepth() {
    const d = await getJSON(API + "/depth?symbol=" + state.symbol + "&limit=20");
    state.book = { bids: d.bids || [], asks: d.asks || [] };
    state.bookUpdatedAt = Date.now();
    renderBook();
    const updates = window.NRPaper.processOpenOrders(state.account, state.symbol, state.book, marks());
    if (updates.length) { persist(); setFeedback("限价委托状态已更新：" + updates.map(x => x.id + " " + x.status).join("、"), "success"); }
    updateEstimate();
    renderAccount();
  }
  async function refreshKlines() {
    const d = await getJSON(API + "/klines?symbol=" + state.symbol + "&interval=" + state.interval + "&limit=240");
    state.klines = d.map(r => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));
    state.lastBar = state.klines[state.klines.length - 1] || null;
    if (state.candleSeries) { state.candleSeries.setData(state.klines); state.chart.timeScale().fitContent(); }
    else drawFallbackChart();
    setText("chartUpdated", "K 线 " + state.klines.length + " 根 · " + state.interval);
    renderSignal();
  }
  function initChart() {
    const host = $("priceChart");
    if (!window.LightweightCharts || !host) { drawFallbackChart(); return; }
    host.innerHTML = "";
    state.chart = LightweightCharts.createChart(host, {
      width: host.clientWidth, height: host.clientHeight,
      layout: { background: { color: "#0c1421" }, textColor: "#8396af", fontSize: 10 },
      grid: { vertLines: { color: "rgba(158,180,210,.06)" }, horzLines: { color: "rgba(158,180,210,.06)" } },
      rightPriceScale: { borderColor: "rgba(158,180,210,.14)" },
      timeScale: { borderColor: "rgba(158,180,210,.14)", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
    });
    state.candleSeries = state.chart.addCandlestickSeries({
      upColor: "#ef5350", downColor: "#21ba72", borderUpColor: "#ef5350", borderDownColor: "#21ba72",
      wickUpColor: "#ef5350", wickDownColor: "#21ba72", priceLineColor: "#f0b90b"
    });
    if (state.klines.length) { state.candleSeries.setData(state.klines); state.chart.timeScale().fitContent(); }
    new ResizeObserver(() => { if (state.chart) state.chart.applyOptions({ width: host.clientWidth, height: host.clientHeight }); }).observe(host);
  }
  function drawFallbackChart() {
    const host = $("priceChart"); if (!host) return;
    host.innerHTML = "";
    const canvas = document.createElement("canvas"); canvas.width = host.clientWidth * 2; canvas.height = host.clientHeight * 2; canvas.style.width = "100%"; canvas.style.height = "100%"; host.appendChild(canvas);
    const ctx = canvas.getContext("2d"), data = state.klines.slice(-100);
    if (!data.length) { ctx.fillStyle = "#71839a"; ctx.fillText("图表库不可用，等待行情数据", 20, 30); return; }
    const w = canvas.width, h = canvas.height, highs = data.map(x => x.high), lows = data.map(x => x.low);
    const max = Math.max.apply(null, highs), min = Math.min.apply(null, lows), span = max - min || 1, step = w / data.length;
    data.forEach((k, i) => {
      const x = i * step + step / 2, y = v => 12 + (max - v) / span * (h - 24);
      const up = k.close >= k.open; ctx.strokeStyle = up ? "#ef5350" : "#21ba72"; ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(x, y(k.high)); ctx.lineTo(x, y(k.low)); ctx.stroke();
      const top = Math.min(y(k.open), y(k.close)), bh = Math.max(2, Math.abs(y(k.open) - y(k.close)));
      ctx.fillRect(x - Math.max(1, step * .28), top, Math.max(2, step * .56), bh);
    });
  }
  function updateLiveCandle(price) {
    if (!state.candleSeries || !state.lastBar) return;
    const bucket = Math.floor(Date.now() / 1000 / INTERVALS[state.interval]) * INTERVALS[state.interval];
    if (bucket > state.lastBar.time) state.lastBar = { time: bucket, open: state.lastBar.close, high: price, low: price, close: price, volume: 0 };
    else state.lastBar = { time: state.lastBar.time, open: state.lastBar.open, high: Math.max(state.lastBar.high, price), low: Math.min(state.lastBar.low, price), close: price, volume: state.lastBar.volume };
    try { state.candleSeries.update(state.lastBar); } catch (_) {}
  }
  function renderBook() {
    const bids = state.book.bids || [], asks = state.book.asks || [];
    const bestBid = bids.length ? Number(bids[0][0]) : 0, bestAsk = asks.length ? Number(asks[0][0]) : 0;
    const spread = bestBid && bestAsk ? (bestAsk - bestBid) / ((bestAsk + bestBid) / 2) * 100 : null;
    setText("spreadValue", spread == null ? "价差 —" : "价差 " + spread.toFixed(3) + "%");
    setText("midPrice", bestBid && bestAsk ? priceFmt((bestBid + bestAsk) / 2) : "—");
    const bidQty = bids.slice(0, 10).reduce((s, x) => s + Number(x[1]), 0), askQty = asks.slice(0, 10).reduce((s, x) => s + Number(x[1]), 0);
    const imbalance = bidQty + askQty ? (bidQty - askQty) / (bidQty + askQty) : 0;
    setText("imbalanceValue", "买盘 " + (imbalance * 100).toFixed(1) + "%");
    renderLevels("askRows", asks.slice(0, 8).reverse(), "ask"); renderLevels("bidRows", bids.slice(0, 8), "bid");
    renderSignal();
  }
  function renderLevels(id, levels, side) {
    const host = $(id); host.innerHTML = "";
    if (!levels.length) { host.innerHTML = '<div class="empty-row">盘口数据暂不可用</div>'; return; }
    let total = 0; const rows = levels.map(x => { total += Number(x[1]); return { price: Number(x[0]), qty: Number(x[1]), total }; });
    const max = Math.max.apply(null, rows.map(x => x.total)) || 1;
    rows.forEach(x => {
      const row = document.createElement("div"); row.className = "book-row"; row.style.setProperty("--depth", (x.total / max * 100).toFixed(1) + "%");
      [priceFmt(x.price), num(x.qty, 5), num(x.total, 5)].forEach((v, i) => { const s = document.createElement("span"); s.textContent = v; if (i === 0) s.className = "book-price"; row.appendChild(s); });
      host.appendChild(row);
    });
  }
  function renderTape() {
    const host = $("tradeTape"); host.innerHTML = "";
    if (!state.trades.length) { host.innerHTML = '<div class="empty-row">等待逐笔成交…</div>'; return; }
    state.trades.slice(0, 30).forEach(t => {
      const row = document.createElement("div"); row.className = "tape-row";
      const p = document.createElement("span"); p.textContent = priceFmt(t.price); p.className = t.buyerMaker ? "negative" : "positive";
      const q = document.createElement("span"); q.textContent = num(t.qty, 5);
      const tm = document.createElement("span"); tm.textContent = new Date(t.time).toLocaleTimeString("zh-CN", { hour12: false });
      row.append(p, q, tm); host.appendChild(row);
    });
  }
  function computeEMA(values, period) {
    if (values.length < period) return null;
    let v = values.slice(0, period).reduce((a, b) => a + b, 0) / period, k = 2 / (period + 1);
    for (let i = period; i < values.length; i++) v = values[i] * k + v * (1 - k);
    return v;
  }
  function computeRSI(values, period) {
    if (values.length <= period) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d > 0) gain += d; else loss -= d; }
    let ag = gain / period, al = loss / period;
    for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; ag = (ag * (period - 1) + Math.max(0, d)) / period; al = (al * (period - 1) + Math.max(0, -d)) / period; }
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  function renderSignal() {
    if (state.klines.length < 55) return;
    const closes = state.klines.map(x => x.close), e20 = computeEMA(closes, 20), e50 = computeEMA(closes, 50), rsi = computeRSI(closes, 14);
    const bids = state.book.bids.slice(0, 10).reduce((s, x) => s + Number(x[1]), 0), asks = state.book.asks.slice(0, 10).reduce((s, x) => s + Number(x[1]), 0);
    const imbalance = bids + asks ? (bids - asks) / (bids + asks) : 0;
    let score = 50, factors = [];
    if (e20 > e50) { score += 18; factors.push("EMA20 高于 EMA50：短期趋势偏强"); } else { score -= 18; factors.push("EMA20 低于 EMA50：短期趋势偏弱"); }
    if (rsi >= 45 && rsi <= 65) { score += 8; factors.push("RSI " + rsi.toFixed(1) + "：动量处于中间区间"); }
    else if (rsi > 70) { score -= 8; factors.push("RSI " + rsi.toFixed(1) + "：短期过热风险"); }
    else if (rsi < 30) { score += 4; factors.push("RSI " + rsi.toFixed(1) + "：出现超卖读数，仍需确认"); }
    else factors.push("RSI " + rsi.toFixed(1) + "：动量未形成强确认");
    score += imbalance * 18; factors.push("前 10 档盘口不平衡 " + (imbalance * 100).toFixed(1) + "%");
    score = Math.max(0, Math.min(100, Math.round(score)));
    setText("signalScore", score + "/100"); $("signalMeter").style.width = score + "%";
    setText("signalLabel", score >= 65 ? "偏强观察" : score <= 35 ? "偏弱观察" : "中性观察");
    const list = $("signalFactors"); list.innerHTML = "";
    factors.forEach(f => { const li = document.createElement("li"); li.textContent = f; list.appendChild(li); });
  }
  function renderAccount() {
    const s = window.NRPaper.summary(state.account, marks());
    setText("equityValue", money(s.equity)); setText("equitySub", "可用现金 " + money(s.availableCash) + " · 初始 " + money(state.account.initialCash));
    setText("dailyPnl", (s.dailyPnl >= 0 ? "+" : "") + money(s.dailyPnl)); colorPnl($("dailyPnl"), s.dailyPnl);
    setText("dailyPnlSub", s.dailyLossLocked ? "已触发单日亏损熔断" : "UTC 日内盯市");
    setText("realizedPnl", (s.realizedPnl >= 0 ? "+" : "") + money(s.realizedPnl)); colorPnl($("realizedPnl"), s.realizedPnl);
    setText("unrealizedPnl", (s.unrealizedPnl >= 0 ? "+" : "") + money(s.unrealizedPnl)); colorPnl($("unrealizedPnl"), s.unrealizedPnl);
    setText("drawdownValue", (s.drawdown * 100).toFixed(2) + "%"); setText("exposureValue", "敞口 " + (s.exposurePct * 100).toFixed(2) + "%");
    setText("availableCash", "可用现金 " + money(s.availableCash));
    const risk = $("riskState"); risk.textContent = s.dailyLossLocked ? "单日亏损熔断：暂停新增买入" : s.drawdownLocked ? "账户回撤熔断：暂停新增买入" : "风险闸门正常"; risk.classList.toggle("warning", s.dailyLossLocked || s.drawdownLocked);
    renderPositions(s.positions); renderOrders(); renderTrades();
    $("submitOrder").disabled = !state.book.asks.length || !state.book.bids.length;
  }
  function renderPositions(positions) {
    const host = $("positionsBody"); host.innerHTML = "";
    if (!positions.length) { host.innerHTML = '<tr><td colspan="6" class="empty-cell">当前没有模拟持仓</td></tr>'; return; }
    positions.forEach(p => {
      const tr = document.createElement("tr");
      const vals = [assetName(p.symbol), num(p.qty, 8), priceFmt(p.avgPrice), priceFmt(p.mark), money(p.marketValue), (p.unrealizedPnl >= 0 ? "+" : "") + money(p.unrealizedPnl)];
      vals.forEach((v, i) => { const td = document.createElement("td"); td.textContent = v; if (i === 5) td.className = p.unrealizedPnl >= 0 ? "positive" : "negative"; tr.appendChild(td); });
      host.appendChild(tr);
    });
  }
  function renderOrders() {
    const host = $("openOrdersBody"); host.innerHTML = "";
    const orders = state.account.orders.filter(o => o.status === "OPEN");
    if (!orders.length) { host.innerHTML = '<tr><td colspan="6" class="empty-cell">暂无挂单</td></tr>'; return; }
    orders.forEach(o => {
      const tr = document.createElement("tr");
      [assetName(o.symbol), o.side === "BUY" ? "买入" : "卖出", "限价", num(o.qty, 7), priceFmt(o.limitPrice)].forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      const td = document.createElement("td"), b = document.createElement("button"); b.className = "ghost-btn"; b.textContent = "撤单"; b.dataset.cancel = o.id; td.appendChild(b); tr.appendChild(td); host.appendChild(tr);
    });
  }
  function renderTrades() {
    const host = $("tradesBody"); host.innerHTML = "";
    const trades = state.account.trades || []; setText("tradeCount", trades.length + " 笔");
    if (!trades.length) { host.innerHTML = '<tr><td colspan="7" class="empty-cell">尚无成交记录</td></tr>'; return; }
    trades.slice(0, 30).forEach(t => {
      const tr = document.createElement("tr"), pnl = t.realizedPnl;
      const vals = [new Date(t.timestamp).toLocaleTimeString("zh-CN", { hour12: false }), assetName(t.symbol), t.side === "BUY" ? "买入" : "卖出", priceFmt(t.price), num(t.qty, 7), money(t.fee), pnl == null ? "—" : (pnl >= 0 ? "+" : "") + money(pnl)];
      vals.forEach((v, i) => { const td = document.createElement("td"); td.textContent = v; if (i === 6 && pnl != null) td.className = pnl >= 0 ? "positive" : "negative"; tr.appendChild(td); }); host.appendChild(tr);
    });
  }
  function setFeedback(message, kind) { const el = $("orderFeedback"); el.textContent = message; el.className = "feedback " + (kind || ""); }
  function selectedReferencePrice() {
    const levels = state.side === "BUY" ? state.book.asks : state.book.bids;
    return levels.length ? Number(levels[0][0]) : Number((state.tickers[state.symbol] || {}).price || 0);
  }
  function updateEstimate() {
    const price = selectedReferencePrice(), qty = Number($("orderQty").value || 0), notional = price * qty;
    setText("estimatePrice", price ? priceFmt(price) : "—"); setText("estimateNotional", notional ? money(notional) : "—"); setText("estimateFee", notional ? money(notional * 0.001) : "—");
    const limitWrap = $("limitPriceWrap"); limitWrap.classList.toggle("hidden", $("orderType").value !== "LIMIT");
    $("submitOrder").textContent = "模拟" + (state.side === "BUY" ? "买入" : "卖出") + " " + assetName(state.symbol);
    $("submitOrder").className = "submit-order " + (state.side === "BUY" ? "buy" : "sell");
  }
  function submitOrder() {
    try {
      const result = window.NRPaper.placeOrder(state.account, { symbol: state.symbol, side: state.side, type: $("orderType").value, qty: Number($("orderQty").value), limitPrice: Number($("limitPrice").value) }, state.book, marks());
      persist("order-submitted-" + String(result.status || "unknown").toLowerCase()); $("orderQty").value = "";
      setFeedback(result.status === "FILLED" ? "模拟成交成功：" + result.order.side + " " + num(result.order.filledQty, 7) + " @ " + priceFmt(result.order.avgFillPrice) : "限价委托已挂出：" + result.order.id + "。触价且可见深度足够时尝试模拟成交。", "success");
    } catch (e) { setFeedback(e.message || "订单未能提交", "error"); }
    updateEstimate();
  }
  function bindControls() {
    $("symbolSelect").addEventListener("change", e => selectSymbol(e.target.value));
    $("marketStrip").addEventListener("click", e => { const b = e.target.closest("[data-symbol]"); if (b) selectSymbol(b.dataset.symbol); });
    $("intervalButtons").addEventListener("click", e => { const b = e.target.closest("[data-interval]"); if (!b) return; state.interval = b.dataset.interval; document.querySelectorAll("[data-interval]").forEach(x => x.classList.toggle("active", x === b)); refreshKlines().catch(err => setText("chartUpdated", "K 线加载失败：" + err.message)); });
    $("buyTab").addEventListener("click", () => setSide("BUY")); $("sellTab").addEventListener("click", () => setSide("SELL"));
    $("orderType").addEventListener("change", updateEstimate); $("orderQty").addEventListener("input", updateEstimate); $("limitPrice").addEventListener("input", updateEstimate);
    document.querySelectorAll("[data-pct]").forEach(b => b.addEventListener("click", () => {
      const s = window.NRPaper.summary(state.account, marks()), p = Number(b.dataset.pct), price = selectedReferencePrice();
      if (!price) return;
      const base = state.side === "BUY" ? Math.max(0, s.availableCash) : Math.max(0, (state.account.positions[state.symbol] || {}).qty || 0) * price;
      $("orderQty").value = (base * p / price / (state.side === "BUY" ? 1.001 : 1)).toPrecision(7); updateEstimate();
    }));
    $("submitOrder").addEventListener("click", submitOrder);
    $("openOrdersBody").addEventListener("click", e => { const b = e.target.closest("[data-cancel]"); if (!b) return; if (window.NRPaper.cancelOrder(state.account, b.dataset.cancel)) { persist("order-cancelled"); setFeedback("已撤销模拟委托 " + b.dataset.cancel, "success"); } });
    $("resetAccount").addEventListener("click", () => { if (!confirm("确定清空当前浏览器中的全部模拟持仓、挂单和成交记录，并恢复 $10,000 初始资金？")) return; state.account = window.NRPaper.resetAccount(); persist("account-reset"); setFeedback("模拟账户已重置。", "success"); });
    $("exportTrades").addEventListener("click", exportTrades);
    window.addEventListener("resize", () => { if (state.chart) state.chart.applyOptions({ width: $("priceChart").clientWidth, height: $("priceChart").clientHeight }); else drawFallbackChart(); });
  }
  function setSide(side) {
    state.side = side; $("buyTab").classList.toggle("selected", side === "BUY"); $("sellTab").classList.toggle("selected", side === "SELL");
    $("buyTab").classList.toggle("buy", side === "BUY"); $("sellTab").classList.toggle("sell", side === "SELL"); updateEstimate();
  }
  async function selectSymbol(symbol) {
    if (!ASSETS.some(a => a.symbol === symbol)) return;
    state.symbol = symbol; $("symbolSelect").value = symbol; setText("chartTitle", assetName(symbol) + " / USDT");
    document.querySelectorAll(".market-card").forEach(b => b.classList.toggle("active", b.dataset.symbol === symbol));
    if (state.socket) { try { state.socket.close(); } catch (_) {} state.socket = null; }
    await Promise.allSettled([refreshKlines(), refreshDepth()]);
    connectSocket(); updateEstimate();
  }

  window.NRTradingRunPaperSelfTest = function () {
    if (!state.book.asks.length || !state.book.bids.length) throw new Error("等待实时盘口加载完成后再运行");
    const symbol = state.symbol;
    const bestAsk = Number(state.book.asks[0][0]);
    const askDepth = state.book.asks.slice(0, 5).reduce((sum, level) => sum + Number(level[1] || 0), 0);
    const bidDepth = state.book.bids.slice(0, 5).reduce((sum, level) => sum + Number(level[1] || 0), 0);
    if (!(bestAsk > 0) || !(askDepth > 0) || !(bidDepth > 0)) throw new Error("盘口数据无效");
    const step = ({ BTCUSDT: 0.000001, ETHUSDT: 0.00001, ORDIUSDT: 0.01, "1000SATSUSDT": 1 })[symbol] || 0.000001;
    const rawQty = Math.min(25 / bestAsk, askDepth * 0.01, bidDepth * 0.01);
    const qty = Number((Math.floor(rawQty / step + 1e-9) * step).toFixed(8));
    if (!(qty > 0) || qty * bestAsk < window.NRPaper.CFG.minNotional) {
      throw new Error("当前可见盘口深度不足以完成最低 $5 的往返自检");
    }
    const sandbox = window.NRPaper.createAccount(10000);
    const snapshotMarks = marks();
    const buy = window.NRPaper.placeOrder(sandbox, { symbol, side: "BUY", type: "MARKET", qty }, state.book, snapshotMarks);
    if (buy.status !== "FILLED") throw new Error("临时账户买入自检未成交");
    const sell = window.NRPaper.placeOrder(sandbox, { symbol, side: "SELL", type: "MARKET", qty }, state.book, snapshotMarks);
    if (sell.status !== "FILLED") throw new Error("临时账户卖出自检未成交");
    const result = window.NRPaper.summary(sandbox, snapshotMarks);
    return {
      symbol, qty,
      buyPrice: buy.order.avgFillPrice,
      sellPrice: sell.order.avgFillPrice,
      buyFee: buy.order.fee,
      sellFee: sell.order.fee,
      realizedPnl: sell.order.realizedPnl,
      endingCash: sandbox.cash,
      trades: sandbox.trades.length,
      liquidityModel: "visible-orderbook-walk",
      persisted: false
    };
  };

  window.NRTradingGetSnapshot = function () {
    const account = window.NRPaper.summary(state.account, marks());
    return {
      capturedAt: Date.now(),
      selectedSymbol: state.symbol,
      interval: state.interval,
      tickers: state.tickers,
      orderBook: {
        capturedAt: state.bookUpdatedAt,
        bids: (state.book.bids || []).slice(0, 20).map(level => [Number(level[0]), Number(level[1])]),
        asks: (state.book.asks || []).slice(0, 20).map(level => [Number(level[0]), Number(level[1])])
      },
      account: {
        equity: account.equity,
        availableCash: account.availableCash,
        dailyPnl: account.dailyPnl,
        realizedPnl: account.realizedPnl,
        unrealizedPnl: account.unrealizedPnl,
        drawdown: account.drawdown,
        exposurePct: account.exposurePct
      },
      positions: state.account.positions,
      risk: { dailyLossLocked: account.dailyLossLocked, drawdownLocked: account.drawdownLocked },
      strategyMetrics: null,
      executionMode: "paper-only"
    };
  };

  window.NRTradingSelectSymbol = selectSymbol;
  function publishSequencedBook() {
    const snapshot = window.NRDepthBook.levels(state.depthBook);
    state.book = { bids: snapshot.bids, asks: snapshot.asks };
    state.bookUpdatedAt = Date.now();
    renderBook();
    const updates = window.NRPaper.processOpenOrders(state.account, state.symbol, state.book, marks());
    if (updates.length) persist("open-order-state-change");
    renderAccount();
  }

  async function syncDepthSnapshot(activeSymbol, generation, ws) {
    if (state.depthResyncing) return;
    state.depthResyncing = true;
    try {
      const snapshot = await getJSON(API + "/depth?symbol=" + activeSymbol + "&limit=1000");
      if (state.socket !== ws || state.socketGeneration !== generation || state.symbol !== activeSymbol) return;
      window.NRDepthBook.loadSnapshot(state.depthBook, snapshot);
      const buffered = state.depthBuffer.splice(0);
      for (let i = 0; i < buffered.length; i++) {
        const result = window.NRDepthBook.applyDiff(state.depthBook, buffered[i]);
        if (result.status === "gap") {
          state.depthBuffer = buffered.slice(i);
          state.depthSynced = false;
          state.depthResyncing = false;
          setConnection("盘口序列出现缺口 · 正在重新同步", true);
          void syncDepthSnapshot(activeSymbol, generation, ws);
          return;
        }
      }
      state.depthSynced = state.depthBook.synced;
      publishSequencedBook();
      if (state.depthSynced && state.socketReady) setConnection("WebSocket 实时行情 · 盘口序列同步", false);
    } catch (_) {
      if (state.socket === ws && state.socketGeneration === generation) {
        state.depthSynced = false;
        setConnection("盘口同步失败 · REST 备用", true);
        setTimeout(() => {
          if (state.socket === ws && state.socketGeneration === generation && !state.depthSynced) {
            state.depthResyncing = false;
            void syncDepthSnapshot(activeSymbol, generation, ws);
          }
        }, 2500);
      }
    } finally {
      state.depthResyncing = false;
    }
  }

  function receiveDepthDiff(event, activeSymbol, generation, ws) {
    if (state.socket !== ws || state.socketGeneration !== generation || state.symbol !== activeSymbol) return;
    if (!state.depthSynced) {
      state.depthBuffer.push(event);
      if (state.depthBuffer.length > 2000) {
        state.depthBuffer = [event];
        state.depthBook.synced = false;
        state.depthResyncing = false;
        void syncDepthSnapshot(activeSymbol, generation, ws);
      }
      return;
    }
    const result = window.NRDepthBook.applyDiff(state.depthBook, event);
    if (result.status === "gap") {
      state.depthSynced = false;
      state.depthBuffer = [event];
      setConnection("盘口序列出现缺口 · 正在重新同步", true);
      void syncDepthSnapshot(activeSymbol, generation, ws);
    } else if (result.status === "applied") {
      publishSequencedBook();
    }
  }

  function connectSocket() {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    const activeSymbol = state.symbol;
    const generation = ++state.socketGeneration;
    const s = activeSymbol.toLowerCase();
    state.depthBook = window.NRDepthBook.create(20);
    state.depthBuffer = [];
    state.depthSynced = false;
    state.depthResyncing = false;
    const streams = [s + "@ticker", s + "@depth@100ms", s + "@trade"].join("/");
    try {
      const ws = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams);
      state.socket = ws; state.socketReady = false;
      ws.onopen = () => {
        if (state.socket !== ws || state.socketGeneration !== generation) return;
        state.socketReady = true;
        setConnection("WebSocket 已连接 · 正在同步盘口", false);
        void syncDepthSnapshot(activeSymbol, generation, ws);
      };
      ws.onmessage = event => {
        try {
          const d = JSON.parse(event.data).data || {};
          if (d.e === "24hrTicker") updateTicker(d.s, { price: d.c, change: d.P, quoteVolume: d.q });
          else if (d.e === "trade") {
            state.trades.unshift({ price: Number(d.p), qty: Number(d.q), time: Number(d.T), buyerMaker: !!d.m });
            if (state.trades.length > 40) state.trades.length = 40;
            renderTape();
            updateLiveCandle(Number(d.p));
          } else if (d.e === "depthUpdate" && Array.isArray(d.b) && Array.isArray(d.a)) {
            receiveDepthDiff(d, activeSymbol, generation, ws);
          }
          setText("lastUpdate", "更新 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        } catch (_) {}
      };
      ws.onerror = () => {
        if (state.socket === ws && state.socketGeneration === generation) {
          setConnection("WebSocket 异常 · REST 备用", true);
        }
      };
      ws.onclose = () => {
        if (state.socket === ws) state.socket = null;
        if (state.socketGeneration !== generation || state.symbol !== activeSymbol) return;
        state.socketReady = false;
        state.depthSynced = false;
        state.depthBuffer = [];
        state.depthResyncing = false;
        setConnection("REST 备用 · 等待重连", true);
        state.reconnectTimer = setTimeout(() => {
          if (state.symbol === activeSymbol && state.socketGeneration === generation) connectSocket();
        }, 4000);
      };
    } catch (_) {
      setConnection("REST 备用", true);
    }
  }
  async function restFallback() {
    try {
      const d = await getJSON(API + "/ticker/24hr?symbol=" + state.symbol);
      updateTicker(state.symbol, { price: d.lastPrice, change: d.priceChangePercent, quoteVolume: d.quoteVolume });
      await refreshDepth();
      if (!state.socketReady) setConnection("REST 轮询 · WebSocket 不可用", true);
    } catch (_) { setConnection("行情接口不可达", true); }
  }
  async function loadResearchGates() {
    try {
      const r = await getJSON("data/research.json"); const cards = r.cards || [];
      const passed = cards.filter(c => c.pass === true);
      setText("gateBadge", passed.length ? passed.length + " PASS" : "未放行");
      $("gateBadge").className = "status-badge " + (passed.length ? "safe" : "blocked");
      setText("gateSummary", passed.length ? passed.length + " 组策略通过现有研究门禁；仍需模拟实战验证。" : "当前研究报告中没有策略通过放行门槛。所有策略仅供观察，不具备实盘资格。");
      const host = $("gateRows"); host.innerHTML = "";
      cards.forEach(c => {
        const row = document.createElement("div"); row.className = "gate-row";
        const left = document.createElement("span"); left.textContent = c.sym + " · " + c.strat;
        const right = document.createElement("b"); right.textContent = c.pass ? "PASS" : (c.reason || "未通过");
        row.append(left, right); host.appendChild(row);
      });
    } catch (_) { setText("gateSummary", "研究 JSON 不可用；策略状态未知，禁止据此开放实盘。"); }
  }
  function exportTrades() {
    const rows = [["time","symbol","side","qty","price","notional","fee","realizedPnl"]];
    state.account.trades.forEach(t => rows.push([t.timestamp,t.symbol,t.side,t.qty,t.price,t.notional,t.fee,t.realizedPnl == null ? "" : t.realizedPnl]));
    const csv = rows.map(row => row.map(v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"').join(",")).join("\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "night-researcher-paper-trades.csv"; a.click(); URL.revokeObjectURL(url);
  }
  async function main() {
    bindControls(); initChart(); renderAccount(); await refreshSnapshot(); await syncPaperLedger();
    await Promise.allSettled([refreshKlines(), refreshDepth()]); connectSocket(); await loadResearchGates();
    state.restTimer = setInterval(() => { refreshSnapshot(); if (!state.socketReady) restFallback(); }, 12000);
    setInterval(() => { if (state.socketReady) refreshDepth().catch(() => {}); }, 15000);
  }
  document.addEventListener("DOMContentLoaded", () => { main().catch(err => { setConnection("初始化失败", true); console.error(err); }); });
})();