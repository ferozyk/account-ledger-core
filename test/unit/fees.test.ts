import { describe, expect, it } from "vitest";
import { daysRequiringOverdraftFee } from "../../src/fees.js";

const FEE = 2500n;
const none = new Set<number>();

describe("daysRequiringOverdraftFee", () => {
  it("returns nothing for an empty history", () => {
    expect(daysRequiringOverdraftFee([], none, FEE)).toEqual([]);
  });

  it("charges each negative day and skips non-negative ones", () => {
    expect(daysRequiringOverdraftFee([100n, -1n, 10n * FEE, -500000n], none, FEE)).toEqual([2, 4]);
  });

  it("cascades: a fee on an earlier day pushes a marginally positive later day negative", () => {
    // Given day 1 is negative and day 2 is only 1 minor unit above zero
    // When the day 1 fee lowers day 2 too
    // Then day 2 also qualifies
    expect(daysRequiringOverdraftFee([-1n, 1n], none, FEE)).toEqual([1, 2]);
  });

  it("does not charge a later day that the cascade leaves at exactly zero", () => {
    expect(daysRequiringOverdraftFee([-1n, FEE], none, FEE)).toEqual([1]);
  });

  it("accumulates several new fees: two cascaded fees push a third day negative", () => {
    // Day 3 is positive after one fee (FEE * 2 - 1 - FEE > 0) but negative after two
    expect(daysRequiringOverdraftFee([-1n, 1n, 2n * FEE - 1n], none, FEE)).toEqual([1, 2, 3]);
  });

  it("skips already charged days and does not cascade a fee that was not newly decided", () => {
    expect(daysRequiringOverdraftFee([-10n, -10n], new Set([1]), FEE)).toEqual([2]);
  });

  it("is idempotent once the result is recorded as charged", () => {
    const balances = [-1n, 1n, 3n * FEE];
    const first = daysRequiringOverdraftFee(balances, none, FEE);
    expect(first).toEqual([1, 2]);
    // Re-run with fees applied to balances, as the ledger would now report
    const applied = balances.map(
      (b, i) => b - FEE * BigInt(first.filter((d) => d <= i + 1).length),
    );
    expect(daysRequiringOverdraftFee(applied, new Set(first), FEE)).toEqual([]);
  });

  it.each([0n, -1n])("rejects a non-positive fee of %s", (fee) => {
    expect(() => daysRequiringOverdraftFee([-1n], none, fee)).toThrow(RangeError);
  });
});
