import { mustParseMoney } from "../src/scenario.js";
import type { LedgerConfig } from "../src/engine.js";
import type {
  Account,
  CreditEvent,
  DebitEvent,
  LedgerEvent,
  Money,
  ReversalEvent,
} from "../src/types.js";

export const aed = (decimal: string): Money => mustParseMoney("AED", decimal);
export const bhd = (decimal: string): Money => mustParseMoney("BHD", decimal);

export const ACC_AED: Account = { id: "A", currency: "AED", openingBalanceMinor: 0n };
export const ACC_BHD: Account = { id: "B", currency: "BHD", openingBalanceMinor: 0n };

export function makeConfig(overrides: Partial<LedgerConfig> = {}): LedgerConfig {
  return {
    accounts: [ACC_AED, ACC_BHD],
    windowDays: 6,
    overdraftFeeMinor: { AED: 2500n },
    dailyInterestRate: { numerator: 4n, denominator: 10000n },
    ...overrides,
  };
}

export const credit = (
  id: string,
  day: number,
  amount: Money,
  extra: Partial<CreditEvent> = {},
): CreditEvent => ({
  id,
  day,
  type: "CREDIT",
  accountId: "A",
  amount,
  valueDate: day,
  ...extra,
});

export const debit = (
  id: string,
  day: number,
  amount: Money,
  extra: Partial<DebitEvent> = {},
): DebitEvent => ({
  id,
  day,
  type: "DEBIT",
  accountId: "A",
  amount,
  valueDate: day,
  ...extra,
});

export const reversal = (
  id: string,
  day: number,
  reversesEventId: string,
  extra: Partial<ReversalEvent> = {},
): ReversalEvent => ({
  id,
  day,
  type: "REVERSAL",
  accountId: "A",
  reversesEventId,
  valueDate: day,
  ...extra,
});

export const authorization = (
  id: string,
  day: number,
  authId: string,
  amount: Money,
): LedgerEvent => ({
  id,
  day,
  type: "AUTHORIZATION",
  accountId: "A",
  authId,
  amount,
  valueDate: day,
});

export const settlement = (
  id: string,
  day: number,
  authId: string,
  amount: Money,
): LedgerEvent => ({
  id,
  day,
  type: "SETTLEMENT",
  accountId: "A",
  authId,
  amount,
  valueDate: day,
});
