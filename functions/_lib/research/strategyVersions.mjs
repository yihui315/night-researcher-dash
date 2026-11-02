// Strategy version freeze / tag.
//
// A "frozen" strategy version captures the exact id + version + params + a content hash so a
// research run can be reproduced and audited. The hash is computed over the normalized
// {id, version, params} payload, so any param change produces a different hash.

import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_BASE_DIR = path.resolve(process.cwd(), "data", "strategy_versions");

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function computeStrategyHash({ id, version, params }) {
  return fnv1a(stableStringify({ id, version, params: params || {} }));
}

// Freeze a strategy version. Returns the frozen record (does not mutate inputs).
export function freezeStrategyVersion({ id, version, params, frozenAt } = {}) {
  if (typeof id !== "string" || id.length === 0) throw new Error("strategy id 必须是非空字符串");
  if (typeof version !== "string" || version.length === 0) throw new Error("strategy version 必须是非空字符串");
  if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params))) {
    throw new Error("strategy params 必须是对象");
  }
  const hash = computeStrategyHash({ id, version, params: params || {} });
  return {
    id,
    version,
    params: params || {},
    hash,
    frozenAt: frozenAt || new Date().toISOString()
  };
}

// Optionally persist the frozen version (append-only, one file per id@version).
export async function saveFrozenVersion(record, { baseDir = DEFAULT_BASE_DIR } = {}) {
  await fs.mkdir(baseDir, { recursive: true });
  const file = path.join(baseDir, `${record.id}@${record.version}.json`);
  await fs.writeFile(file, JSON.stringify(record, null, 2), "utf8");
  return file;
}

// Attach a human tag to a frozen record (returns a new tagged record).
export function tagVersion(record, tag) {
  if (!record || typeof record !== "object") throw new Error("无效的策略版本记录");
  if (typeof tag !== "string" || tag.length === 0) throw new Error("tag 必须是非空字符串");
  return { ...record, tag };
}
