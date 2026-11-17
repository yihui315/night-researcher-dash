// tests/six-roles-replay.test.mjs — 六角色离线 Mock-Replay 验收（P1 / AI Provider）
//
// 验证：在没有真实 LLM Key / 网络的情况下，六角色决策闭环仍可运行并完成接口验收。
// 走 provider="replay"，回放录制好的角色响应；确定性门禁（KELLY 无样本拒绝）仍生效。
// 运行：node --test tests/six-roles-replay.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createModelCaller,
  detectRoleId,
  loadReplayStore,
} from "../functions/_lib/six-roles/adapter.mjs";
import { runCycle } from "../functions/_lib/six-roles/pipeline.mjs";

test("detectRoleId: 从 content 抽取 AGENT_ID", () => {
  assert.equal(detectRoleId([{ role: "user", content: "x AGENT_ID: EDGE y" }]), "EDGE");
  assert.equal(detectRoleId([{ role: "user", content: "无标记" }]), null);
});

test("loadReplayStore: 默认 fixture 加载且各角色有文本", () => {
  const store = loadReplayStore();
  for (const role of ["SPOTTER", "PRIOR", "EDGE", "CLOSER"]) {
    assert.ok(typeof store[role] === "string" && store[role].length > 0, role);
  }
});

test("replay provider: 按角色返回录制文本且 usage 为零", async () => {
  const c = createModelCaller({ provider: "replay" });
  assert.equal(c.provider, "replay");
  const r = await c.callModel([{ role: "user", content: "AGENT_ID: CLOSER\n..." }]);
  assert.equal(c.model, "replay");
  assert.match(r.text, /HOLD_RESEARCH/);
  assert.deepEqual(r.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test("runCycle(replay): 离线确定性闭环 — 无 Key / 无网络，门禁仍生效", async () => {
  const c = createModelCaller({ provider: "replay" });
  const marketSnapshot = {
    snapshot_id: "snap-1",
    selectedSymbol: "BTCUSDT",
    orderBook: { capturedAt: 0, asks: [["30005", "1"]], bids: [["30004", "1"]] },
  };
  const metrics = { sampleCount: 0 }; // 触发 KELLY 无样本拒绝
  const account = { equity: 100000 };
  const res = await runCycle({
    runId: "run-1",
    strategyId: "s1",
    strategyVersion: "v1",
    marketSnapshot,
    modelCaller: c,
    metrics,
    account,
  });
  // 全部角色记录均来自 replay provider（无真实调用）
  for (const role of ["SPOTTER", "PRIOR", "EDGE", "CLOSER"]) {
    assert.equal(res.roles[role].provider, "replay", role + " provider");
    assert.equal(res.roles[role].model, "replay", role + " model");
  }
  // 确定性门禁：KELLY 无样本 → size=0、status=BLOCKED
  assert.equal(res.roles.KELLY.size, 0);
  assert.equal(res.roles.KELLY.status, "BLOCKED");
  // KELLY 拦截晋升 → 链被拒（REJECTED_CHAIN）
  assert.equal(res.finalDecision, "REJECTED_CHAIN");
});

test("runCycle(replay): 真实样本 + 策略通过 → 晋升提案（仍由 replay 文本驱动）", async () => {
  const c = createModelCaller({ provider: "replay" });
  const marketSnapshot = {
    snapshot_id: "snap-2",
    selectedSymbol: "BTCUSDT",
    orderBook: { capturedAt: Date.now(), asks: [["30005", "1"]], bids: [["30004", "1"]] },
  };
  const metrics = { strategyPass: true, oosPass: true, sampleCount: 200, oosTrades: 60, winRate: 0.55, avgWinPct: 1.2, avgLossPct: 0.9 };
  const account = { equity: 100000 };
  const res = await runCycle({
    runId: "run-2",
    strategyId: "s2",
    strategyVersion: "v2",
    marketSnapshot,
    modelCaller: c,
    metrics,
    account,
  });
  // KELLY 给出正仓位
  assert.equal(res.roles.KELLY.size > 0, true, "KELLY 应给出正仓位");
  assert.equal(res.roles.KELLY.status, "READY");
  // EDGE 通过 + KELLY 就绪 → TAKER 仅提案
  assert.equal(res.roles.TAKER.proposal_status, "PROPOSAL_ONLY");
  // 账户未被 TAKER 篡改（G4 不变性）
  assert.equal(res.roles.TAKER.__accountUntouched, true);
  assert.equal(res.finalDecision, "PROMOTE_AND_PROPOSE");
});
