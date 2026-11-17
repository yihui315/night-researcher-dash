// Anomaly / missing-data detection over collected snapshots.
//
// Flags two classes of problems:
//   1. Per-snapshot integrity: null/NaN/non-positive prices, missing order book, crossed book.
//   2. Series gaps: missing expected timestamps when an expected sampling interval is known.

function isBadNumber(v) {
  return v == null || typeof v !== "number" || Number.isNaN(v);
}

export function detectAnomalies(snapshots, { expectedStepMs } = {}) {
  const anomalies = [];
  const sorted = [...snapshots].sort((a, b) =>
    (a.timestampMs != null ? a.timestampMs : Date.parse(a.timestamp)) -
    (b.timestampMs != null ? b.timestampMs : Date.parse(b.timestamp))
  );

  for (const s of sorted) {
    const id = s.snapshot_id || s.symbol;
    if (isBadNumber(s.lastPrice) || s.lastPrice <= 0) {
      anomalies.push({ snapshot_id: id, type: "missing_or_invalid_lastPrice", detail: "lastPrice 缺失或非正" });
    }
    if (isBadNumber(s.bid) || isBadNumber(s.ask) || s.bid <= 0 || s.ask <= 0) {
      anomalies.push({ snapshot_id: id, type: "missing_or_invalid_quote", detail: "bid/ask 缺失或非正" });
    }
    if (isBadNumber(s.volume24h)) {
      anomalies.push({ snapshot_id: id, type: "missing_volume", detail: "volume24h 缺失" });
    }
    const ob = s.orderBook;
    if (!ob || !Array.isArray(ob.bids) || !Array.isArray(ob.asks) || ob.bids.length === 0 || ob.asks.length === 0) {
      anomalies.push({ snapshot_id: id, type: "missing_orderbook", detail: "订单簿缺失或为空" });
    } else if (ob.bids[0][0] >= ob.asks[0][0]) {
      anomalies.push({ snapshot_id: id, type: "crossed_book", detail: "买一价 >= 卖一价（交叉盘口）" });
    }
    if (!isBadNumber(s.bid) && !isBadNumber(s.ask) && s.ask < s.bid) {
      anomalies.push({ snapshot_id: id, type: "negative_spread", detail: "ask < bid" });
    }
  }

  // Gap detection on the time axis.
  if (expectedStepMs && sorted.length > 1) {
    for (let i = 1; i < sorted.length; i++) {
      const t0 = sorted[i - 1].timestampMs != null ? sorted[i - 1].timestampMs : Date.parse(sorted[i - 1].timestamp);
      const t1 = sorted[i].timestampMs != null ? sorted[i].timestampMs : Date.parse(sorted[i].timestamp);
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 - t0 > expectedStepMs * 1.5) {
        anomalies.push({
          snapshot_id: sorted[i].snapshot_id || sorted[i].symbol,
          type: "time_gap",
          detail: "缺失约 " + Math.round((t1 - t0) / expectedStepMs - 1) + " 个预期采样点"
        });
      }
    }
  }

  return anomalies;
}
