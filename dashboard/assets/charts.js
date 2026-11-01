/* charts.js — 零依赖 Canvas 图表库（暗色量化主题）
   红涨绿跌：涨=红(#ef4d56)，跌=绿(#21ba72)，符合中国交易习惯。 */
const NRCharts = (() => {
  const UP = "#ef4d56";    // 涨 红
  const DOWN = "#21ba72";  // 跌 绿
  const GRID = "rgba(255,255,255,0.06)";
  const AXIS = "rgba(255,255,255,0.45)";
  const TEXT = "rgba(255,255,255,0.72)";

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 240;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function fmtPrice(v) {
    if (v == null || isNaN(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (a >= 1) return v.toFixed(2);
    if (a >= 0.01) return v.toFixed(4);
    return v.toFixed(6);
  }

  // 主图：蜡烛 + EMA 线 + 最新价标线
  function candles(canvas, { klines, ema, symbol }) {
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!klines || klines.length === 0) return;
    const padL = 8, padR = 60, padT = 12, padB = 18;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    let all = [];
    klines.forEach(k => all.push(k.h, k.l));
    if (ema) ema.forEach(v => { if (v != null) all.push(v); });
    let min = Math.min(...all), max = Math.max(...all);
    const rng = (max - min) || 1;
    min -= rng * 0.06; max += rng * 0.06;
    const n = klines.length;
    const x = i => padL + (i + 0.5) * (plotW / n);
    const y = v => padT + (1 - (v - min) / (max - min)) * plotH;
    ctx.strokeStyle = GRID; ctx.fillStyle = TEXT; ctx.font = "10px system-ui";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (let g = 0; g <= 4; g++) {
      const yy = padT + g * plotH / 4;
      const val = max - g * (max - min) / 4;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.fillText(fmtPrice(val), padL + plotW + 4, yy);
    }
    const cw = Math.max(1, (plotW / n) * 0.6);
    for (let i = 0; i < n; i++) {
      const k = klines[i];
      const up = k.c >= k.o;
      ctx.strokeStyle = up ? UP : DOWN; ctx.fillStyle = up ? UP : DOWN;
      ctx.beginPath(); ctx.moveTo(x(i), y(k.h)); ctx.lineTo(x(i), y(k.l)); ctx.stroke();
      const yo = y(k.o), yc = y(k.c);
      const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(x(i) - cw / 2, top, cw, bh);
    }
    if (ema) {
      ctx.strokeStyle = "#f0b90b"; ctx.lineWidth = 1.3; ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (ema[i] == null) continue;
        const px = x(i), py = y(ema[i]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke(); ctx.lineWidth = 1;
    }
    const last = klines[n - 1].c, ly = y(last);
    ctx.strokeStyle = "rgba(240,185,11,0.5)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(padL + plotW, ly); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#f0b90b"; ctx.fillRect(padL + plotW, ly - 8, padR, 16);
    ctx.fillStyle = "#10121a"; ctx.textAlign = "left"; ctx.fillText(fmtPrice(last), padL + plotW + 4, ly);
    ctx.fillStyle = TEXT; ctx.textAlign = "left"; ctx.fillText(symbol || "", padL, 6);
  }

  // RSI 副图
  function rsi(canvas, { rsi }) {
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!rsi || rsi.length === 0) return;
    const padL = 8, padR = 60, padT = 8, padB = 8;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const y = v => padT + (1 - v / 100) * plotH;
    ctx.strokeStyle = GRID; ctx.fillStyle = TEXT; ctx.font = "10px system-ui";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    [30, 50, 70].forEach(lv => {
      const yy = y(lv);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.fillText(String(lv), padL + plotW + 6, yy);
    });
    ctx.strokeStyle = "#5b9bd5"; ctx.lineWidth = 1.3; ctx.beginPath();
    let st = false;
    for (let i = 0; i < rsi.length; i++) {
      if (rsi[i] == null) continue;
      const px = padL + (i + 0.5) * (plotW / rsi.length), py = y(rsi[i]);
      if (!st) { ctx.moveTo(px, py); st = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = TEXT; ctx.textAlign = "left"; ctx.fillText("RSI(14)", padL, 6);
  }

  // 折线图（带面积）+ 端点标签 + 起止日期
  function line(canvas, { points, color, fmt }) {
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!points || points.length === 0) return;
    const padL = 8, padR = 64, padT = 12, padB = 18;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const vals = points.map(p => p.y);
    let min = Math.min(...vals), max = Math.max(...vals);
    const r = (max - min) || 1; min -= r * 0.08; max += r * 0.08;
    const x = i => padL + (i + 0.5) * (plotW / points.length);
    const y = v => padT + (1 - (v - min) / (max - min)) * plotH;
    ctx.strokeStyle = GRID; ctx.fillStyle = TEXT; ctx.font = "10px system-ui";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (let g = 0; g <= 3; g++) {
      const yy = padT + g * plotH / 3;
      const val = max - g * (max - min) / 3;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.fillText((fmt || fmtPrice)(val), padL + plotW + 4, yy);
    }
    const col = color || "#f0b90b";
    ctx.beginPath(); ctx.moveTo(x(0), y(points[0].y));
    for (let i = 1; i < points.length; i++) ctx.lineTo(x(i), y(points[i].y));
    ctx.lineTo(x(points.length - 1), padT + plotH); ctx.lineTo(x(0), padT + plotH);
    ctx.closePath(); ctx.fillStyle = col + "22"; ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const px = x(i), py = y(points[i].y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke(); ctx.lineWidth = 1;
    const lv = points[points.length - 1].y, ly = y(lv);
    ctx.fillStyle = col; ctx.fillRect(padL + plotW, ly - 8, padR, 16);
    ctx.fillStyle = "#10121a"; ctx.textAlign = "left";
    ctx.fillText((fmt || fmtPrice)(lv), padL + plotW + 4, ly);
    ctx.fillStyle = TEXT; ctx.textAlign = "left"; ctx.fillText(points[0].x, padL, padT + plotH + 12);
    ctx.textAlign = "right"; ctx.fillText(points[points.length - 1].x, padL + plotW, padT + plotH + 12);
  }

  // 柱状图（生态时代均值对比）
  function bars(canvas, { bars }) {
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!bars || bars.length === 0) return;
    const padL = 8, padR = 8, padT = 22, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const max = Math.max(...bars.map(b => b.value)) || 1;
    const n = bars.length, bw = plotW / n * 0.56;
    ctx.font = "10px system-ui"; ctx.textBaseline = "middle";
    const palette = ["#5b6b8c", "#f0b90b", "#ef4d56"];
    bars.forEach((b, i) => {
      const bh = (b.value / max) * plotH;
      const bx = padL + (i + 0.5) * (plotW / n) - bw / 2;
      const by = padT + plotH - bh;
      ctx.fillStyle = palette[i % palette.length]; ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = TEXT; ctx.textAlign = "center"; ctx.fillText("$" + b.value.toFixed(1) + "M", bx + bw / 2, by - 8);
      ctx.fillStyle = AXIS; ctx.fillText(b.label, bx + bw / 2, padT + plotH + 12);
      ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.fillText(b.sub || "", bx + bw / 2, padT + plotH + 24);
    });
    ctx.fillStyle = TEXT; ctx.textAlign = "left"; ctx.fillText("日均手续费 (USD M)", padL, 10);
  }

  function fmtCompact(v) {
    if (v == null || isNaN(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toFixed(0);
  }

  // 成交量副图（红涨绿跌：阳线红、阴线绿，半透明）
  function volume(canvas, { klines }) {
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!klines || klines.length === 0) return;
    const padL = 8, padR = 60, padT = 8, padB = 8;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const vols = klines.map(k => k.v);
    const maxV = Math.max(...vols) || 1;
    const n = klines.length;
    const bw = Math.max(1, (plotW / n) * 0.6);
    const x = i => padL + (i + 0.5) * (plotW / n);
    const y = v => padT + (1 - v / maxV) * plotH;
    for (let i = 0; i < n; i++) {
      const k = klines[i];
      const up = k.c >= k.o;
      ctx.fillStyle = (up ? UP : DOWN) + "55";
      const bx = x(i) - bw / 2;
      const by = y(k.v);
      ctx.fillRect(bx, by, bw, padT + plotH - by);
    }
    ctx.fillStyle = TEXT; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.font = "10px system-ui";
    ctx.fillText("VOL", padL, 6);
    ctx.fillText(fmtCompact(maxV), padL + plotW + 4, padT + 8);
  }

  return { candles, rsi, line, bars, volume, fmtPrice, fmtCompact, UP, DOWN };
})();
