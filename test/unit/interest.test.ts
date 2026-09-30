import { describe, expect, it } from "vitest";
import { accrueDailyInterest } from "../../src/interest.js";

const RATE = { numerator: 4n, denominator: 10000n };

describe("accrueDailyInterest", () => {
  it("accrues ACC-001's final value-dated balances and totals the rounded amounts", () => {
    // Given 250.00, 225.00, 625.00, 415.00, 390.00, 390.00 AED (in fils)
    const result = accrueDailyInterest([25000n, 22500n, 62500n, 41500n, 39000n, 39000n], RATE);
    // Then 0.10 + 0.09 + 0.25 + 0.17 (16.6) + 0.16 (15.6) + 0.16 = 0.93
    expect(result.daily).toEqual([10n, 9n, 25n, 17n, 16n, 16n]);
    expect(result.totalMinor).toBe(93n);
  });

  it("accrues the BHD scenario, leaving zero-balance days at zero", () => {
    const result = accrueDailyInterest([0n, 0n, 0n, 0n, 10000n, 10000n], RATE);
    expect(result.daily).toEqual([0n, 0n, 0n, 0n, 4n, 4n]);
    expect(result.totalMinor).toBe(8n);
  });

  it("accrues nothing on zero or negative balances", () => {
    const result = accrueDailyInterest([0n, -1n, -999999n], RATE);
    expect(result.daily).toEqual([0n, 0n, 0n]);
    expect(result.totalMinor).toBe(0n);
  });

  it("returns an empty result for no days", () => {
    expect(accrueDailyInterest([], RATE)).toEqual({ daily: [], totalMinor: 0n });
  });

  it.each([
    [5n, 0n], // 0.5 -> 0 (even)
    [15n, 2n], // 1.5 -> 2 (even)
    [25n, 2n], // 2.5 -> 2 (even)
    [35n, 4n], // 3.5 -> 4 (even)
    [14n, 1n], // 1.4 -> 1
    [16n, 2n], // 1.6 -> 2
  ])("rounds exact-tenth accrual of %s/10 half-to-even to %s", (balance, expected) => {
    const result = accrueDailyInterest([balance], { numerator: 1n, denominator: 10n });
    expect(result.daily).toEqual([expected]);
  });

  it("keeps the total equal to the sum of the rounded daily accruals", () => {
    const balances = Array.from({ length: 200 }, (_, i) => BigInt((i * 7919) % 100003) - 20000n);
    const { daily, totalMinor } = accrueDailyInterest(balances, {
      numerator: 3n,
      denominator: 7000n,
    });
    expect(totalMinor).toBe(daily.reduce((a, b) => a + b, 0n));
    expect(daily.every((amount) => amount >= 0n)).toBe(true);
  });
});
