import test from "node:test";
import assert from "node:assert/strict";
import { priceFromPriceTick, priceTickFromPrice, twapFromCumulatives } from "../src/math.js";
import { precheck } from "../src/vaults.js";
import { HSK } from "../src/config.js";

test("price ticks match the live HSKSwap WHSK/USDT pool", () => {
  // tick -300536 read from the pool on 2026-10-27 => ~0.0886 USDT per HSK
  const p = priceFromPriceTick(-300536, 18, 6);
  assert.ok(Math.abs(p - 0.0886) < 0.0005, `got ${p}`);
  assert.equal(priceTickFromPrice(p, 18, 6), -300536);
});

test("TWAP rounding matches the contract (towards -infinity)", () => {
  assert.equal(twapFromCumulatives(0n, -1201n, 600), -3);
  assert.equal(twapFromCumulatives(0n, 1201n, 600), 2);
  assert.equal(twapFromCumulatives(0n, -1200n, 600), -2);
});

const base = {
  policy: HSK.policy,
  equity: 10_000,
  exposure: 0,
  dayStartEquity: 10_000,
  paused: false,
  openCount: 0,
  lastOpenAt: 0,
  now: 1_000_000,
};
const m = { twapOk: true, spotPriceTick: 100, twapPriceTick: 100 };

test("precheck mirrors the on-chain rules", () => {
  assert.equal(precheck(base, m, 1000, 300, 600), null);
  assert.equal(precheck(base, m, 2500, 300, 600), "PositionTooLarge");
  assert.equal(precheck(base, m, 1000, 50, 600), "StopOutOfRange");
  assert.equal(precheck(base, { ...m, spotPriceTick: 300 }, 1000, 300, 600), "TwapDeviation");
  assert.equal(precheck({ ...base, equity: 9400 }, m, 100, 300, 600), "DailyLossLimit");
  assert.equal(precheck({ ...base, exposure: 5500 }, m, 1000, 300, 600), "ExposureTooHigh");
  assert.equal(precheck({ ...base, paused: true }, m, 100, 300, 600), "VaultPaused");
});
