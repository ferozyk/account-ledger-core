import { accrueDailyInterest } from "./interest.js";
import { daysRequiringOverdraftFee } from "./fees.js";
import { Ledger, type EntryDraft } from "./ledger.js";
import { AuthorizationBook } from "./authorizations.js";
import { allocate, formatMinor, type Rate } from "./money.js";
import type {
  Account,
  AccountDayReport,
  AccountId,
  AuthorizationEvent,
  Currency,
  CreditEvent,
  DayReport,
  DebitEvent,
  Day,
  EodError,
  EventId,
  EventOutcome,
  LedgerEntry,
  LedgerEvent,
  Logger,
  Rejection,
  RejectionCode,
  ReplayResult,
  RestatedAccount,
  RestatedView,
  Result,
  ReversalEvent,
  SettlementEvent,
} from "./types.js";

export interface LedgerConfig {
  readonly accounts: readonly Account[];
  readonly windowDays: number;
  readonly overdraftFeeMinor: Partial<Record<Currency, bigint>>;
  readonly dailyInterestRate: Rate;
}

interface SeenEvent {
  readonly event: LedgerEvent;
  readonly outcome: EventOutcome;
}

/** What a type-specific handler produced for an accepted event. */
interface Handled {
  readonly entries: readonly LedgerEntry[];
  readonly notices?: readonly string[];
}

type HandlerResult = Result<Handled, Rejection>;

/** What was capitalized, captured at capitalization time so the restated view shows it exactly. */
interface Capitalization {
  readonly closingBeforeInterest: readonly bigint[];
  readonly dailyAccrual: readonly bigint[];
}

const reject = (code: RejectionCode, message: string): Rejection => ({ code, message });
const failWith = (code: RejectionCode, message: string): HandlerResult => ({
  ok: false,
  error: reject(code, message),
});
const isValidDay = (day: number): boolean => Number.isInteger(day) && day >= 1;

function assertNever(value: never): never {
  throw new Error(`Unhandled event: ${JSON.stringify(value)}`);
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

/** Why a reversal may not proceed against an existing target, or undefined when it may. */
function reversalProblem(event: ReversalEvent, target: SeenEvent): string | undefined {
  if (target.outcome.status === "REJECTED") {
    return `event ${target.event.id} was rejected`;
  }
  if (target.event.type !== "CREDIT" && target.event.type !== "DEBIT") {
    return `only CREDIT and DEBIT events can be reversed, not ${target.event.type}`;
  }
  if (target.event.accountId !== event.accountId) {
    return `event ${target.event.id} belongs to another account`;
  }
  if (target.event.valueDate !== event.valueDate) {
    return `value date ${event.valueDate} differs from the original ${target.event.valueDate}`;
  }
  return undefined;
}

export class LedgerEngine {
  private readonly ledger: Ledger;
  private readonly book = new AuthorizationBook();
  private readonly outcomeLog: EventOutcome[] = [];
  private readonly seen = new Map<EventId, SeenEvent>();
  private readonly reversed = new Set<EventId>();
  private readonly capitalizations = new Map<AccountId, Capitalization>();
  private day: Day = 1;

  constructor(
    private readonly config: LedgerConfig,
    private readonly logger: Logger,
  ) {
    this.assertValidConfig();
    this.ledger = new Ledger(config.accounts);
  }

  get currentDay(): Day {
    return this.day;
  }

  get windowClosed(): boolean {
    return this.day > this.config.windowDays;
  }

  /** Append-only view of the ledger entries. */
  entries(): readonly LedgerEntry[] {
    return this.ledger.entries();
  }

  /** Balance by value date <= `day`, as currently known. */
  closingBalance(accountId: AccountId, day: Day): bigint {
    return this.ledger.closingBalance(accountId, day);
  }

  outcomes(): readonly EventOutcome[] {
    return [...this.outcomeLog];
  }

  /** Closes days in order until the engine is on `day`; never closes the last day of the window. */
  advanceTo(day: Day): DayReport[] {
    const reports: DayReport[] = [];
    while (this.day < Math.min(day, this.config.windowDays)) {
      reports.push(this.closeDay());
    }
    return reports;
  }

  /** Closes every remaining day of the window. */
  closeWindow(): DayReport[] {
    const reports: DayReport[] = [];
    while (!this.windowClosed) {
      reports.push(this.closeDay());
    }
    return reports;
  }

  process(event: LedgerEvent): EventOutcome {
    const bookingDay = this.bookingDayFor(event);
    const notices = this.lateNotices(event, bookingDay);
    const result = this.decide(event, bookingDay);
    const outcome = result.ok
      ? this.appliedOutcome(
          event,
          bookingDay,
          [...notices, ...(result.value.notices ?? [])],
          result.value.entries,
        )
      : this.rejectedOutcome(event, bookingDay, notices, result.error);
    this.record(event, outcome);
    return outcome;
  }

  closeDay(): DayReport {
    const day = this.day;
    if (this.windowClosed) {
      throw new Error(
        `Cannot close day ${day}: the window of ${this.config.windowDays} days is closed`,
      );
    }
    const eodErrors: EodError[] = [];
    const accounts = this.ledger
      .accounts()
      .map((account) => this.closeAccount(account, day, eodErrors));
    const report: DayReport = {
      day,
      accounts,
      authorizations: this.book.all(),
      outcomes: this.outcomeLog.filter((outcome) => outcome.bookingDay === day),
      eodErrors,
    };
    this.day += 1;
    this.logger.info("day.closed", { day, events: report.outcomes.length });
    return report;
  }

  restatedView(): RestatedView {
    if (!this.windowClosed) {
      throw new Error("Restated view is only available once the window has closed");
    }
    return { accounts: this.ledger.accounts().map((account) => this.restatedAccount(account)) };
  }

  // -- configuration ---------------------------------------------------------

  private assertValidConfig(): void {
    const { windowDays, overdraftFeeMinor } = this.config;
    if (!Number.isSafeInteger(windowDays) || windowDays < 1) {
      throw new RangeError(`windowDays must be a positive integer, got ${windowDays}`);
    }
    for (const fee of Object.values(overdraftFeeMinor)) {
      if (fee <= 0n) {
        throw new RangeError(`Overdraft fee must be positive, got ${fee}`);
      }
    }
  }

  // -- event processing ------------------------------------------------------

  /** A late event (its day already closed) is booked on the current day. */
  private bookingDayFor(event: LedgerEvent): Day {
    return event.day >= this.day ? event.day : this.day;
  }

  private lateNotices(event: LedgerEvent, bookingDay: Day): string[] {
    if (!isValidDay(event.day) || event.day >= this.day) {
      return [];
    }
    const notice = `arrived for day ${event.day} after day ${event.day} closed; booked on day ${bookingDay}`;
    this.logger.warn("event.late", { eventId: event.id, eventDay: event.day, bookingDay });
    return [notice];
  }

  private decide(event: LedgerEvent, bookingDay: Day): HandlerResult {
    const rejection = this.validate(event, bookingDay);
    return rejection === undefined
      ? this.handle(event, bookingDay)
      : { ok: false, error: rejection };
  }

  private validate(event: LedgerEvent, bookingDay: Day): Rejection | undefined {
    return (
      this.checkDuplicate(event) ??
      this.checkAccount(event) ??
      this.checkWindow(event, bookingDay) ??
      this.checkValueDate(event, bookingDay) ??
      this.checkCurrency(event)
    );
  }

  private checkDuplicate(event: LedgerEvent): Rejection | undefined {
    return this.seen.has(event.id)
      ? reject("DUPLICATE_EVENT", `Event ${event.id} was already processed`)
      : undefined;
  }

  private checkAccount(event: LedgerEvent): Rejection | undefined {
    return this.ledger.account(event.accountId) === undefined
      ? reject("UNKNOWN_ACCOUNT", `Unknown account ${event.accountId}`)
      : undefined;
  }

  private checkWindow(event: LedgerEvent, bookingDay: Day): Rejection | undefined {
    return !isValidDay(event.day) || bookingDay > this.config.windowDays
      ? reject(
          "OUTSIDE_WINDOW",
          `Day ${event.day} is outside the window 1..${this.config.windowDays}`,
        )
      : undefined;
  }

  private checkValueDate(event: LedgerEvent, bookingDay: Day): Rejection | undefined {
    const valid = isValidDay(event.valueDate) && event.valueDate <= bookingDay;
    return valid
      ? undefined
      : reject(
          "INVALID_VALUE_DATE",
          `Value date ${event.valueDate} must be an integer between 1 and booking day ${bookingDay}`,
        );
  }

  private checkCurrency(event: LedgerEvent): Rejection | undefined {
    if (event.type === "REVERSAL") {
      return undefined;
    }
    const accountCurrency = this.ledger.account(event.accountId)?.currency;
    return event.amount.currency === accountCurrency
      ? undefined
      : reject(
          "CURRENCY_MISMATCH",
          `Event currency ${event.amount.currency} differs from account currency ${accountCurrency}`,
        );
  }

  private handle(event: LedgerEvent, bookingDay: Day): HandlerResult {
    switch (event.type) {
      case "CREDIT":
        return this.handleCredit(event, bookingDay);
      case "DEBIT":
        return this.handleDebit(event, bookingDay);
      case "AUTHORIZATION":
        return this.handleAuthorization(event, bookingDay);
      case "SETTLEMENT":
        return this.handleSettlement(event, bookingDay);
      case "REVERSAL":
        return this.handleReversal(event, bookingDay);
      default:
        return assertNever(event);
    }
  }

  private handleCredit(event: CreditEvent, bookingDay: Day): HandlerResult {
    const instalments = event.instalments ?? 1;
    if (event.amount.minor <= 0n) {
      return failWith("INVALID_AMOUNT", "Credit amount must be positive");
    }
    if (
      !Number.isInteger(instalments) ||
      instalments < 1 ||
      BigInt(instalments) > event.amount.minor
    ) {
      return failWith(
        "INVALID_AMOUNT",
        `Instalments must be a positive integer no larger than the amount in minor units, got ${instalments}`,
      );
    }
    const drafts = allocate(event.amount.minor, instalments).map((part) =>
      this.eventDraft(event, bookingDay, "CREDIT", part),
    );
    return { ok: true, value: { entries: this.ledger.append(drafts) } };
  }

  private handleDebit(event: DebitEvent, bookingDay: Day): HandlerResult {
    if (event.amount.minor <= 0n) {
      return failWith("INVALID_AMOUNT", "Debit amount must be positive");
    }
    // No balance check: overdrafts are allowed and charged by the end-of-day fee rule.
    const draft = this.eventDraft(event, bookingDay, "DEBIT", -event.amount.minor);
    return { ok: true, value: { entries: this.ledger.append([draft]) } };
  }

  private handleAuthorization(event: AuthorizationEvent, bookingDay: Day): HandlerResult {
    const available =
      this.ledger.closingBalance(event.accountId, bookingDay) -
      this.book.activeHoldsMinor(event.accountId);
    const result = this.book.request(
      { authId: event.authId, accountId: event.accountId, amount: event.amount, day: bookingDay },
      available,
    );
    if (!result.ok) {
      return result;
    }
    const { currency, minor } = event.amount;
    const figures = `available ${formatMinor(currency, available)}, requested ${formatMinor(currency, minor)}`;
    const approved = result.value.status === "APPROVED";
    this.logger.info(approved ? "authorization.approved" : "authorization.declined", {
      eventId: event.id,
      authId: event.authId,
    });
    const notice = `authorization ${event.authId} ${approved ? "approved, hold placed" : "declined"}: ${figures}`;
    return { ok: true, value: { entries: [], notices: [notice] } };
  }

  private handleSettlement(event: SettlementEvent, bookingDay: Day): HandlerResult {
    const settled = this.book.settle({
      authId: event.authId,
      accountId: event.accountId,
      amount: event.amount,
      day: bookingDay,
    });
    if (!settled.ok) {
      return settled;
    }
    const draft = this.eventDraft(event, bookingDay, "SETTLEMENT", -event.amount.minor);
    return { ok: true, value: { entries: this.ledger.append([draft]) } };
  }

  private handleReversal(event: ReversalEvent, bookingDay: Day): HandlerResult {
    const target = this.seen.get(event.reversesEventId);
    if (target === undefined) {
      return failWith("UNKNOWN_REVERSAL_TARGET", `Unknown event ${event.reversesEventId}`);
    }
    const problem = reversalProblem(event, target);
    if (problem !== undefined) {
      return failWith("REVERSAL_NOT_ALLOWED", problem);
    }
    if (this.reversed.has(target.event.id)) {
      return failWith("ALREADY_REVERSED", `Event ${target.event.id} was already reversed`);
    }
    const drafts = this.ledger
      .entriesForSourceEvent(target.event.id)
      .map((original): EntryDraft => ({
        accountId: original.accountId,
        currency: original.currency,
        kind: "REVERSAL",
        amountMinor: -original.amountMinor,
        valueDate: event.valueDate,
        bookingDay,
        sourceEventId: event.id,
        reversesEntryId: original.entryId,
      }));
    const entries = this.ledger.append(drafts);
    this.reversed.add(target.event.id);
    return { ok: true, value: { entries } };
  }

  private eventDraft(
    event: CreditEvent | DebitEvent | SettlementEvent,
    bookingDay: Day,
    kind: "CREDIT" | "DEBIT" | "SETTLEMENT",
    amountMinor: bigint,
  ): EntryDraft {
    return {
      accountId: event.accountId,
      currency: event.amount.currency,
      kind,
      amountMinor,
      valueDate: event.valueDate,
      bookingDay,
      sourceEventId: event.id,
    };
  }

  private appliedOutcome(
    event: LedgerEvent,
    bookingDay: Day,
    notices: readonly string[],
    entries: readonly LedgerEntry[],
  ): EventOutcome {
    return {
      eventId: event.id,
      accountId: event.accountId,
      bookingDay,
      status: "APPLIED",
      notices,
      entries,
    };
  }

  private rejectedOutcome(
    event: LedgerEvent,
    bookingDay: Day,
    notices: readonly string[],
    rejection: Rejection,
  ): EventOutcome {
    return {
      eventId: event.id,
      accountId: event.accountId,
      bookingDay,
      status: "REJECTED",
      rejection,
      notices,
      entries: [],
    };
  }

  /** Appends to the outcome log; the first outcome per event id is the one reversals look up. */
  private record(event: LedgerEvent, outcome: EventOutcome): void {
    this.outcomeLog.push(outcome);
    if (!this.seen.has(event.id)) {
      this.seen.set(event.id, { event, outcome });
    }
    if (outcome.rejection === undefined) {
      this.logger.info("event.applied", {
        eventId: event.id,
        accountId: event.accountId,
        type: event.type,
      });
    } else {
      this.logger.warn("event.rejected", {
        eventId: event.id,
        accountId: event.accountId,
        code: outcome.rejection.code,
      });
    }
  }

  // -- end of day ------------------------------------------------------------

  private closeAccount(account: Account, day: Day, eodErrors: EodError[]): AccountDayReport {
    const feesAssessed = this.assessFees(account, day, eodErrors);
    const interest =
      day === this.config.windowDays ? this.capitalizeInterest(account, day) : undefined;
    const closingLedgerMinor = this.ledger.closingBalance(account.id, day);
    const activeHoldsMinor = this.book.activeHoldsMinor(account.id);
    return {
      accountId: account.id,
      currency: account.currency,
      closingLedgerMinor,
      activeHoldsMinor,
      availableMinor: closingLedgerMinor - activeHoldsMinor,
      feesAssessed,
      ...(interest === undefined ? {} : { interestCapitalized: interest }),
    };
  }

  private assessFees(account: Account, day: Day, eodErrors: EodError[]): LedgerEntry[] {
    const balances = this.ledger.closingBalances(account.id, day);
    const charged = this.chargedFeeDays(account.id);
    const feeMinor = this.config.overdraftFeeMinor[account.currency];
    if (feeMinor === undefined) {
      this.flagMissingFee(account, day, balances, charged, eodErrors);
      return [];
    }
    const days = daysRequiringOverdraftFee(balances, charged, feeMinor);
    if (days.length === 0) {
      return [];
    }
    const fees = this.ledger.append(
      days.map((valueDate): EntryDraft => ({
        accountId: account.id,
        currency: account.currency,
        kind: "FEE",
        amountMinor: -feeMinor,
        valueDate,
        bookingDay: day,
      })),
    );
    fees.forEach((fee) =>
      this.logger.info("fee.assessed", {
        accountId: account.id,
        valueDate: fee.valueDate,
        bookingDay: day,
        amountMinor: fee.amountMinor,
      }),
    );
    return fees;
  }

  /** Fees already in the ledger are the single source of truth for idempotency. */
  private chargedFeeDays(accountId: AccountId): Set<Day> {
    return new Set(
      this.ledger
        .entriesForAccount(accountId)
        .filter((entry) => entry.kind === "FEE")
        .map((entry) => entry.valueDate),
    );
  }

  private flagMissingFee(
    account: Account,
    day: Day,
    balances: readonly bigint[],
    charged: ReadonlySet<Day>,
    eodErrors: EodError[],
  ): void {
    const feeDue = balances.some((balance, index) => balance < 0n && !charged.has(index + 1));
    if (!feeDue) {
      return;
    }
    eodErrors.push({ code: "FEE_NOT_CONFIGURED", accountId: account.id, day });
    this.logger.error("fee.not_configured", {
      accountId: account.id,
      currency: account.currency,
      day,
    });
  }

  /** Runs after fees, so the accrual base excludes the capitalization itself. */
  private capitalizeInterest(account: Account, day: Day): LedgerEntry | undefined {
    const closingBeforeInterest = this.ledger.closingBalances(account.id, day);
    const { daily, totalMinor } = accrueDailyInterest(
      closingBeforeInterest,
      this.config.dailyInterestRate,
    );
    this.capitalizations.set(account.id, { closingBeforeInterest, dailyAccrual: daily });
    if (totalMinor <= 0n) {
      return undefined;
    }
    const [entry] = this.ledger.append([
      {
        accountId: account.id,
        currency: account.currency,
        kind: "INTEREST",
        amountMinor: totalMinor,
        valueDate: day,
        bookingDay: day,
      },
    ]);
    this.logger.info("interest.capitalized", {
      accountId: account.id,
      day,
      amountMinor: totalMinor,
    });
    return entry;
  }

  private restatedAccount(account: Account): RestatedAccount {
    const capitalization = this.capitalizations.get(account.id);
    if (capitalization === undefined) {
      throw new Error(`No interest capitalization recorded for ${account.id}`);
    }
    const closings = this.ledger.closingBalances(account.id, this.config.windowDays);
    const days = closings.map((closingMinor, index) => ({
      day: index + 1,
      closingMinor,
      closingBeforeInterestMinor: capitalization.closingBeforeInterest[index] ?? closingMinor,
      dailyAccrualMinor: capitalization.dailyAccrual[index] ?? 0n,
    }));
    const capitalizedMinor = sum(
      this.ledger
        .entriesForAccount(account.id)
        .filter((entry) => entry.kind === "INTEREST")
        .map((entry) => entry.amountMinor),
    );
    const accrualSumMinor = sum(capitalization.dailyAccrual);
    return {
      accountId: account.id,
      currency: account.currency,
      days,
      capitalizedMinor,
      accrualSumMinor,
      accrualMatchesCapitalized: accrualSumMinor === capitalizedMinor,
    };
  }
}

/** Replays an event stream: closes each day before the first event of a later day, then the rest. */
export function replay(
  config: LedgerConfig,
  events: readonly LedgerEvent[],
  logger: Logger,
): ReplayResult {
  const engine = new LedgerEngine(config, logger);
  const dayReports: DayReport[] = [];
  for (const event of events) {
    dayReports.push(...engine.advanceTo(event.day));
    engine.process(event);
  }
  dayReports.push(...engine.closeWindow());
  return { dayReports, restated: engine.restatedView(), outcomes: engine.outcomes() };
}
