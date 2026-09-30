import { parseMoney } from "./money.js";
import type { Currency, LedgerEvent, Money } from "./types.js";
import type { LedgerConfig } from "./engine.js";

/** Fixtures are programmer input: a bad literal is a bug, so it throws. */
export function mustParseMoney(currency: Currency, decimal: string): Money {
  const parsed = parseMoney(currency, decimal);
  if (!parsed.ok) {
    throw new Error(`Invalid fixture amount ${decimal} ${currency}: ${parsed.error.message}`);
  }
  return parsed.value;
}

const aed = (decimal: string): Money => mustParseMoney("AED", decimal);

export const SCENARIO_CONFIG: LedgerConfig = {
  accounts: [
    { id: "ACC-001", currency: "AED", openingBalanceMinor: 0n },
    { id: "ACC-002", currency: "BHD", openingBalanceMinor: 0n },
  ],
  windowDays: 6,
  overdraftFeeMinor: { AED: 2500n },
  dailyInterestRate: { numerator: 4n, denominator: 10000n },
};

export const SCENARIO_EVENTS: readonly LedgerEvent[] = [
  { id: "E1", day: 1, type: "CREDIT", accountId: "ACC-001", amount: aed("1200.00"), valueDate: 1 },
  { id: "E2", day: 1, type: "DEBIT", accountId: "ACC-001", amount: aed("950.00"), valueDate: 1 },
  {
    id: "E3",
    day: 2,
    type: "AUTHORIZATION",
    accountId: "ACC-001",
    authId: "Auth-A",
    amount: aed("200.00"),
    valueDate: 2,
  },
  { id: "E4", day: 3, type: "CREDIT", accountId: "ACC-001", amount: aed("400.00"), valueDate: 3 },
  {
    id: "E5",
    day: 4,
    type: "SETTLEMENT",
    accountId: "ACC-001",
    authId: "Auth-A",
    amount: aed("185.00"),
    valueDate: 4,
  },
  {
    id: "E6",
    day: 4,
    type: "SETTLEMENT",
    accountId: "ACC-001",
    authId: "Auth-Z",
    amount: aed("180.00"),
    valueDate: 4,
  },
  { id: "E7", day: 5, type: "DEBIT", accountId: "ACC-001", amount: aed("620.00"), valueDate: 2 },
  {
    id: "E8",
    day: 5,
    type: "AUTHORIZATION",
    accountId: "ACC-001",
    authId: "Auth-B",
    amount: aed("90.00"),
    valueDate: 5,
  },
  { id: "E9", day: 6, type: "REVERSAL", accountId: "ACC-001", reversesEventId: "E7", valueDate: 2 },
  {
    id: "E10",
    day: 5,
    type: "CREDIT",
    accountId: "ACC-002",
    amount: mustParseMoney("BHD", "10.000"),
    instalments: 3,
    valueDate: 5,
  },
];
