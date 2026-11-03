// Market-snapshot collection + append-only persistence.
//
// Every snapshot gets a unique snapshot_id and an ISO timestamp. Raw snapshots are APPENDED
// under data/market_snapshots/<SYMBOL>/ — existing files are never overwritten. The id embeds
// the symbol, a minute-resolution timestamp and an 8-char content hash, so duplicates are
// de-duplicated and distinct content always yields a distinct, stable file name.

import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_BASE_DIR = path.resolve(process.cwd(), "data", "market_snapshots");

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function utcStamp(ms) {
  const d = new Date(ms);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return (
    d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds())
  );
}

export function buildSnapshotId(symbol, timestampMs, content) {
  return `${symbol}_${utcStamp(timestampMs)}_${fnv1a(symbol + ":" + timestampMs + ":" + content)}`;
}

// Collect a single snapshot from a source and persist it (append-only).
// Returns metadata { snapshot_id, path, symbol, timestamp, sizeBytes, duplicate }.
export async function collectSnapshot(source, symbol, { baseDir = DEFAULT_BASE_DIR, timestamp } = {}) {
  const snapshot = await source.getSnapshot(symbol, { timestamp });
  const content = JSON.stringify(snapshot);
  const snapshot_id = buildSnapshotId(symbol, snapshot.timestampMs, content);
  const dir = path.join(baseDir, symbol);
  const file = path.join(dir, snapshot_id + ".json");
  await fs.mkdir(dir, { recursive: true });

  let duplicate = false;
  try {
    await fs.access(file);
    duplicate = true; // identical content -> same id -> same file: do not overwrite
  } catch (_) {
    const record = { snapshot_id, ...snapshot };
    await fs.writeFile(file, JSON.stringify(record, null, 2), "utf8");
  }
  const stat = await fs.stat(file);
  return { snapshot_id, path: file, symbol, timestamp: snapshot.timestamp, sizeBytes: stat.size, duplicate };
}

// Collect a whole series for one symbol.
export async function collectSeries(source, symbol, { baseDir = DEFAULT_BASE_DIR, fromIso, toIso, stepMs } = {}) {
  const series = await source.getSeries(symbol, { fromIso, toIso, stepMs });
  const results = [];
  for (const snap of series) {
    results.push(await collectSnapshot(source, symbol, { baseDir, timestamp: snap.timestampMs }));
  }
  return results;
}

// Load all persisted snapshots (optionally for one symbol), sorted by timestamp.
export async function loadSnapshots({ baseDir = DEFAULT_BASE_DIR, symbol } = {}) {
  const symbols = symbol ? [symbol] : (await fs.readdir(baseDir).catch(() => []));
  const out = [];
  for (const sym of symbols) {
    const dir = path.join(baseDir, sym);
    let files;
    try {
      files = await fs.readdir(dir);
    } catch (_) {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      try {
        out.push(JSON.parse(raw));
      } catch (_) {
        // skip unreadable files
      }
    }
  }
  out.sort((a, b) => (a.timestampMs || Date.parse(a.timestamp)) - (b.timestampMs || Date.parse(b.timestamp)));
  return out;
}

// Convenience: count persisted snapshots (used by tests for uniqueness checks).
export async function countSnapshots({ baseDir = DEFAULT_BASE_DIR } = {}) {
  const all = await loadSnapshots({ baseDir });
  return all.length;
}
