import { formatMinor } from "./money.js";
import type {
  AccountDayReport,
  Authorization,
  Currency,
  DayReport,
  EodError,
  EventOutcome,
  LedgerEntry,
  ReplayResult,
  RestatedAccount,
} from "./types.js";

const money = (currency: Currency, minor: bigint): string =>
  `${formatMinor(currency, minor)} ${currency}`;

const pad = (text: string, width: number): string => text.padEnd(width);
const padLeft = (text: string, width: number): string => text.padStart(width);

function formatAccountLine(account: AccountDayReport): string {
  const { currency } = account;
  return [
    `  ${pad(account.accountId, 8)}`,
    `ledger ${padLeft(money(currency, account.closingLedgerMinor), 14)}`,
    `holds ${padLeft(money(currency, account.activeHoldsMinor), 13)}`,
    `available ${padLeft(money(currency, account.availableMinor), 14)}`,
  ].join("  ");
}

function formatFeeLine(account: AccountDayReport, fee: LedgerEntry): string {
  return `  ${pad(account.accountId, 8)}  value day ${fee.valueDate}  ${money(account.currency, fee.amountMinor)}`;
}

function formatFees(accounts: readonly AccountDayReport[]): string[] {
  const lines = accounts.flatMap((account) =>
    account.feesAssessed.map((fee) => formatFeeLine(account, fee)),
  );
  return ["Fees assessed:", ...(lines.length > 0 ? lines : ["  (none)"])];
}

function formatInterest(accounts: readonly AccountDayReport[]): string[] {
  const lines = accounts.flatMap((account) =>
    account.interestCapitalized === undefined
      ? []
      : [
          `  ${pad(account.accountId, 8)}  ${money(account.currency, account.interestCapitalized.amountMinor)}`,
        ],
  );
  return lines.length > 0 ? ["Interest capitalized:", ...lines] : [];
}

function formatSettlement(auth: Authorization): string {
  if (auth.settledAmountMinor === undefined) {
    return "";
  }
  return `  settled ${money(auth.amount.currency, auth.settledAmountMinor)} on day ${auth.settledDay}`;
}

function formatAuthorization(auth: Authorization): string {
  const amount = money(auth.amount.currency, auth.amount.minor);
  return `  ${pad(auth.authId, 8)}  ${pad(auth.accountId, 8)}  ${padLeft(amount, 14)}  ${pad(auth.status, 8)}${formatSettlement(auth)}`;
}

function formatEntry(entry: LedgerEntry): string {
  return `${entry.kind} ${money(entry.currency, entry.amountMinor)} (value day ${entry.valueDate})`;
}

function formatApplied(outcome: EventOutcome): string {
  return outcome.entries.length > 0
    ? outcome.entries.map(formatEntry).join("; ")
    : "no ledger entries";
}

function formatOutcome(outcome: EventOutcome): string[] {
  const head = `  ${pad(outcome.eventId, 5)}  ${pad(outcome.accountId, 8)}  ${pad(outcome.status, 8)}`;
  const detail =
    outcome.rejection === undefined
      ? formatApplied(outcome)
      : `${outcome.rejection.code}: ${outcome.rejection.message}`;
  const notices = outcome.notices.map((notice) => `         note: ${notice}`);
  return [`${head}  ${detail}`.trimEnd(), ...notices];
}

function formatEodError(error: EodError): string {
  return `  ${error.code} for ${error.accountId} on day ${error.day}`;
}

function section(title: string, lines: readonly string[], emptyText: string): string[] {
  return [title, ...(lines.length > 0 ? lines : [emptyText])];
}

function formatDay(report: DayReport): string {
  const lines = [
    `=== Day ${report.day} (end of day, as known) ===`,
    "Balances:",
    ...report.accounts.map(formatAccountLine),
    ...formatFees(report.accounts),
    ...formatInterest(report.accounts),
    ...section("Authorizations:", report.authorizations.map(formatAuthorization), "  (none)"),
    ...section("Events booked this day:", report.outcomes.flatMap(formatOutcome), "  (none)"),
  ];
  if (report.eodErrors.length > 0) {
    lines.push("End-of-day errors:", ...report.eodErrors.map(formatEodError));
  }
  return lines.join("\n");
}

function formatRestatedAccount(account: RestatedAccount): string {
  const { currency } = account;
  const rows = account.days.map(
    (day) =>
      `  ${padLeft(String(day.day), 3)} | ${padLeft(money(currency, day.closingMinor), 16)} | ${padLeft(money(currency, day.closingBeforeInterestMinor), 16)} | ${padLeft(money(currency, day.dailyAccrualMinor), 12)}`,
  );
  return [
    `${account.accountId} (${currency})`,
    `  ${padLeft("day", 3)} | ${padLeft("closing (final)", 16)} | ${padLeft("before interest", 16)} | ${padLeft("accrual", 12)}`,
    ...rows,
    `  capitalized total: ${money(currency, account.capitalizedMinor)}`,
    `  sum of daily accruals: ${money(currency, account.accrualSumMinor)}  check: ${account.accrualMatchesCapitalized ? "OK" : "MISMATCH"}`,
  ].join("\n");
}

function formatOutsideWindow(result: ReplayResult): string[] {
  const lastDay = result.dayReports.at(-1)?.day ?? 0;
  const outside = result.outcomes.filter((outcome) => outcome.bookingDay > lastDay);
  return outside.length === 0
    ? []
    : ["=== Events outside the window ===\n" + outside.flatMap(formatOutcome).join("\n")];
}

/** Human-readable, fixed-width plain-text rendering of a full replay. */
export function formatReplay(result: ReplayResult): string {
  const restated = [
    "=== Restated by value date (final) ===",
    ...result.restated.accounts.map(formatRestatedAccount),
  ].join("\n");
  return [...result.dayReports.map(formatDay), ...formatOutsideWindow(result), restated].join(
    "\n\n",
  );
}
