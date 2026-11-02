// 迁移前后数据一致性测试
// 复刻 migrations/0003_fixed_point.sql 的核心变换 CAST(ROUND(x * 100000000) AS INTEGER)，
// 验证旧 REAL 浮点金额迁移到定点 INTEGER(1e8) 后：
//   (a) 与 fixed-point 引擎层(decimal.mjs)的内部定点 BigInt 完全一致（迁移前后口径一致）；
//   (b) 在 1e-8 定点网格上无损（round-trip 稳定）；
//   (c) 浮点漂移（如 0.1+0.2）在迁移中被精确纠正为 0.3。
//
// 关键语义：0003 迁移后的 INTEGER 列值 = 实际金额 * 1e8，正是引擎内部定点 BigInt 的同一尺度。
// 因此引擎内部 D("0.1") === 10000000n 与迁移 INTEGER 10000000 是同一整数，不可再经 D() 二次缩放。
// 恢复真实金额用 toNumber(BigInt(integer))（= Number(U(BigInt(integer)))）。
//
// 注：SQLite ROUND 采用"远离零"的半向上舍入；JS Math.round 对负数半向上偏向 +Inf，
// 故对负数单独按 away-from-zero 复刻，确保与 D1 实际语义一致。

const test = require("node:test");
const assert = require("node:assert/strict");
const { D, U, toNumber } = require("../functions/_lib/decimal.mjs");

// 复刻 0003 的 CAST(ROUND(x*1e8) AS INTEGER)，返回"已缩放整数"（= 引擎内部 BigInt 同尺度）
function migrateRealToFixed(x) {
  if (x === null || x === undefined) return null;
  const scaled = x * 100000000;
  // 远离零的半向上舍入（匹配 SQLite ROUND 对 REAL 的行为）
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

// 将迁移得到的"已缩放整数"当作引擎内部 BigInt
const asFixed = (v) => BigInt(v);

test("迁移变换与引擎定点层口径一致（金额值覆盖正负/零/大数）", () => {
  const samples = [
    "0", "0.1", "0.3", "0.001", "10.00001000", "10000.01",
    "-0.001", "-10.00001000", "-10000.01",
    "1000000.12345678", "-1000000.12345678"
  ];
  for (const s of samples) {
    const engineFixed = D(s);                       // 引擎内部定点 BigInt（= 金额 * 1e8）
    const oldReal = Number(s);                      // 迁移前 DB 中的 REAL 浮点值
    const migrated = migrateRealToFixed(oldReal);    // 0003 后 INTEGER 值（已缩放整数）
    // 一致性：迁移得到的 INTEGER 必须等于引擎层定点 BigInt（同为已缩放整数）
    assert.ok(asFixed(migrated) === engineFixed,
      `迁移 INTEGER(${migrated}) 与引擎定点(${engineFixed}) 不一致 @ ${s}`);
    // round-trip：已缩放整数经 U() 应回到同一 8 位定点字符串
    assert.equal(U(engineFixed), U(asFixed(migrated)),
      `round-trip 字符串不一致 @ ${s}`);
  }
});

test("浮点漂移在迁移中被精确纠正（0.1+0.2 不再等于 0.30000000000000004）", () => {
  const driftReal = 0.1 + 0.2;             // 浮点下 = 0.30000000000000004
  assert.notEqual(driftReal, 0.3, "前置：确认 JS 浮点确实存在漂移");
  const migrated = migrateRealToFixed(driftReal);
  // ROUND(0.30000000000000004 * 1e8) = ROUND(30000000.000000004) = 30000000 → 0.3
  assert.equal(migrated, 30000000);
  assert.equal(toNumber(asFixed(migrated)), 0.3);
  assert.equal(U(asFixed(migrated)), "0.30000000");
});

test("手续费场景：10000.01 * 0.001 迁移前后一致", () => {
  const notionalReal = 10000.01;
  const feeReal = notionalReal * 0.001;    // 浮点下 ≈ 10.000009999999999
  const notionalFixed = migrateRealToFixed(notionalReal); // 1000001000000
  const feeFixed = migrateRealToFixed(feeReal);           // 1000001000
  // 引擎层定点计算：mul(D("10000.01"), D("0.001")) = 1000001000n(=10.00001000 * 1e8)
  const engineFee = mul(D("10000.01"), D("0.001"));
  assert.equal(feeFixed, 1000001000, "手续费迁移值应为 10.00001000 * 1e8");
  assert.equal(engineFee, 1000001000n, "引擎定点手续费应为 10.00001000 * 1e8");
  // 迁移后的手续费(以元计)与引擎口径(以元计)在 1e-8 网格上等价
  assert.equal(toNumber(asFixed(feeFixed)), toNumber(engineFee));
});

test("迁移对 NULL 金额列安全（realized_pnl/limit_price/average_fill_price 可为 NULL）", () => {
  assert.equal(migrateRealToFixed(null), null);
  assert.equal(migrateRealToFixed(undefined), null);
});

test("迁移可逆性：随机金额 round-trip 误差 < 1e-8（定点网格分辨率）", () => {
  const cases = ["0.00000001", "123.45678901", "999999.99999999", "500000.5", "0.99999999"];
  for (const s of cases) {
    const fixed = migrateRealToFixed(Number(s));      // 已缩放整数
    const restored = toNumber(asFixed(fixed));         // INTEGER / 1e8（真实金额）
    const diff = Math.abs(restored - Number(s));
    assert.ok(diff <= 1e-8, `round-trip 误差 ${diff} 超出定点网格 @ ${s}`);
    // 样本均在 1e-8 网格上精确，round-trip 后规范字符串应完全一致
    assert.equal(U(asFixed(fixed)), U(D(s)), `round-trip 规范字符串不一致 @ ${s}`);
  }
});

// 局部 mul 引用（避免从引擎再导入造成测试耦合；语义与 decimal.mjs 的 mul 一致）
function mul(a, b) {
  const SCALE = 10n ** 8n;
  const aa = typeof a === "bigint" ? a : D(a);
  const bb = typeof b === "bigint" ? b : D(b);
  return (aa * bb) / SCALE;
}
