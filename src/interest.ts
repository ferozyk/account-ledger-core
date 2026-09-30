import { applyRate, type Rate } from "./money.js";

/**
 * Accrues one rounded interest amount per day on positive closing balances only.
 * The total is the sum of the rounded daily amounts; nothing is rounded twice or discarded.
 */
export function accrueDailyInterest(
  closingBalances: readonly bigint[],
  rate: Rate,
): { daily: bigint[]; totalMinor: bigint } {
  const daily = closingBalances.map((balance) => (balance > 0n ? applyRate(balance, rate) : 0n));
  const totalMinor = daily.reduce((sum, amount) => sum + amount, 0n);
  return { daily, totalMinor };
}
