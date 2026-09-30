import type { Day } from "./types.js";

/**
 * Decides which days need a new overdraft fee.
 *
 * `closingBalances[i]` is the current closing ledger balance of day `i + 1`, already including
 * previously booked fees. A fee booked on day d is value-dated d, so it lowers the closing balance
 * of d and every later day; the single ascending pass carries that cumulative effect.
 */
export function daysRequiringOverdraftFee(
  closingBalances: readonly bigint[],
  alreadyChargedDays: ReadonlySet<Day>,
  feeMinor: bigint,
): Day[] {
  if (feeMinor <= 0n) {
    throw new RangeError(`Overdraft fee must be positive, got ${feeMinor}`);
  }
  const days: Day[] = [];
  let newFeesMinor = 0n;
  closingBalances.forEach((balance, index) => {
    const day = index + 1;
    const adjusted = balance - newFeesMinor;
    if (adjusted < 0n && !alreadyChargedDays.has(day)) {
      days.push(day);
      newFeesMinor += feeMinor;
    }
  });
  return days;
}
