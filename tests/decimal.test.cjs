// 定点金额计算（BigInt 1e8）单元测试
// 对照分支 A 原 `REAL`+`toFixed(12)` 浮点方案的经典缺陷，证明定点化正确。
const test = require("node:test");
const assert = require("node:assert/strict");
const dec = require("../functions/_lib/decimal.mjs");

test("D/解析：浮点桥接不产生表示误差（0.1+0.2=0.3）", () => {
  // 浮点下 0.1+0.2 !== 0.3（经典缺陷）；定点必须等于 0.3
  assert.ok(0.1 + 0.2 !== 0.3);
  assert.notEqual(String(0.1 + 0.2), "0.3");
  const sum = dec.add(dec.D(0.1), dec.D(0.2));
  assert.equal(dec.U(sum), "0.30000000");
  assert.ok(dec.eq(dec.add(0.1, 0.2), dec.D("0.3"))); // 定点正确
});

test("U/序列化：固定 8 位小数且可逆", () => {
  assert.equal(dec.U(dec.D("123.456789")), "123.45678900");
  assert.equal(dec.U(dec.D("10000")), "10000.00000000");
  assert.equal(dec.trimmed(dec.D("10000.50000000")), "10000.5");
  assert.equal(dec.D(dec.U(dec.D("99.99999999"))).toString(), dec.D("99.99999999").toString());
});

test("mul：手续费计算精确（10000.00 * 0.001 = 10.00）", () => {
  const notional = dec.D("10000.00");
  const fee = dec.mul(notional, dec.D("0.001"));
  assert.equal(dec.U(fee), "10.00000000");
  // 浮点缺陷反证：0.1+0.2 串化即见漂移尾数 "0000000000000004"
  assert.ok(String(0.1 + 0.2).includes("0000000000000004"));
  const n2 = dec.D("10000.01");
  const f2 = dec.mul(n2, dec.D("0.001"));
  assert.equal(dec.U(f2), "10.00001000");
});

test("mul：大额名义金额无精度损失（纯 BigInt 整数运算，无浮点）", () => {
  const price = dec.D("65432.12345678");
  const qty = dec.D("1234.56789012");
  const notional = dec.mul(price, qty); // 约 8.078e7，远超 Number 安全整数区也无损
  // 手工缩放乘积 + 半向上四舍五入，与模块一致
  const a = 6543212345678n, b = 123456789012n;
  const p = a * b; // 精确整数乘积
  const half = 10n ** 8n / 2n;
  const rounded = (p + half) / 10n ** 8n;
  assert.equal(notional.toString(), rounded.toString());
  // 除法还原均价精确
  assert.equal(dec.U(dec.div(notional, qty)), "65432.12345678");
});

test("div：名义/数量 还原均价精确", () => {
  const notional = dec.D("10000.00");
  const qty = dec.D("0.5");
  const avg = dec.div(notional, qty);
  assert.equal(dec.U(avg), "20000.00000000");
});

test("add/sub：账户余额累加无漂移", () => {
  let cash = dec.D("10000.00000000");
  cash = dec.add(cash, dec.D("0.1"));
  cash = dec.add(cash, dec.D("0.2")); // 浮点下会得 10000.30000000000001
  assert.equal(dec.U(cash), "10000.30000000");
  cash = dec.sub(cash, dec.D("0.3"));
  assert.equal(dec.U(cash), "10000.00000000");
});

test("cmp/gt/gte/lt/lte：比较正确", () => {
  assert.equal(dec.cmp("1.00000001", "1.00000000"), 1);
  assert.ok(dec.gt("1.00000001", "1.00000000"));
  assert.ok(dec.gte("1.00000000", "1.00000000"));
  assert.ok(dec.lt("0.99999999", "1.00000000"));
  assert.ok(dec.lte("1.00000000", "1.00000000"));
});

test("min/max/abs/neg", () => {
  assert.equal(dec.U(dec.min("5.5", "3.3")), "3.30000000");
  assert.equal(dec.U(dec.max("5.5", "3.3")), "5.50000000");
  assert.equal(dec.U(dec.abs(dec.D("-7.7"))), "7.70000000");
  assert.equal(dec.U(dec.neg(dec.D("7.7"))), "-7.70000000");
});

test("四舍五入：mul/div 半向上舍入一致", () => {
  // 1.000000005（超出 8 位）解析应入到 1.00000001
  assert.equal(dec.U(dec.D("1.000000005")), "1.00000001");
  assert.equal(dec.U(dec.D("1.000000004")), "1.00000000");
});

test("toJson/fromJson：落库字符串往返一致（JSON 不支持 BigInt 的桥接）", () => {
  const b = dec.D("250.12345678");
  const json = dec.toJson(b);
  assert.equal(typeof json, "string");
  assert.equal(dec.fromJson(json).toString(), b.toString());
});
