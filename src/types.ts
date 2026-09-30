// Domain contract shared by every module. Amounts are always bigint minor units
// (fils for AED and BHD alike: 1 AED = 100 fils, 1 BHD = 1000 fils).

export type Currency = "AED" | "BHD";

/** Business day inside the replay window, 1-based. */
export type Day = number;

export type AccountId = string;
export type EventId = string;
export type AuthId = string;

export interface Money {
  readonly currency: Currency;
  /** Non-negative amount in minor units. Direction is carried by the event/entry kind. */
  readonly minor: bigint;
}

export interface Account {
  readonly id: AccountId;
  readonly currency: Currency;
  readonly openingBalanceMinor: bigint;
}

// ---------------------------------------------------------------------------
// Input events (the replayed stream). Immutable once constructed.
// ---------------------------------------------------------------------------

interface EventBase {
  readonly id: EventId;
  /** Business day on which the event arrives (booking day). */
  readonly day: Day;
  readonly accountId: AccountId;
  readonly valueDate: Day;
}

export interface CreditEvent extends EventBase {
  readonly type: "CREDIT";
  readonly amount: Money;
  /** Number of postings the credit is split into. Defaults to 1. */
  readonly instalments?: number;
}

export interface DebitEvent extends EventBase {
  readonly type: "DEBIT";
  readonly amount: Money;
}

export interface AuthorizationEvent extends EventBase {
  readonly type: "AUTHORIZATION";
  readonly authId: AuthId;
  readonly amount: Money;
}

export interface SettlementEvent extends EventBase {
  readonly type: "SETTLEMENT";
  readonly authId: AuthId;
  readonly amount: Money;
}

export interface ReversalEvent extends EventBase {
  readonly type: "REVERSAL";
  readonly reversesEventId: EventId;
}

export type LedgerEvent =
  CreditEvent | DebitEvent | AuthorizationEvent | SettlementEvent | ReversalEvent;

// ---------------------------------------------------------------------------
// Ledger entries (append-only). Signed amount: credit > 0, debit < 0.
// ---------------------------------------------------------------------------

export type EntryKind = "CREDIT" | "DEBIT" | "SETTLEMENT" | "REVERSAL" | "FEE" | "INTEREST";

export interface LedgerEntry {
  readonly entryId: string;
  readonly accountId: AccountId;
  readonly currency: Currency;
  readonly kind: EntryKind;
  readonly amountMinor: bigint;
  readonly valueDate: Day;
  readonly bookingDay: Day;
  /** Input event that caused the entry; absent for system entries (FEE, INTEREST). */
  readonly sourceEventId?: EventId;
  /** For REVERSAL entries: the entry being compensated. */
  readonly reversesEntryId?: string;
}

// ---------------------------------------------------------------------------
// Authorizations
// ---------------------------------------------------------------------------

export type AuthorizationStatus = "APPROVED" | "DECLINED" | "SETTLED";

export interface Authorization {
  readonly authId: AuthId;
  readonly accountId: AccountId;
  readonly amount: Money;
  readonly status: AuthorizationStatus;
  readonly requestedDay: Day;
  readonly settledAmountMinor?: bigint;
  readonly settledDay?: Day;
}

// ---------------------------------------------------------------------------
// Processing outcomes
// ---------------------------------------------------------------------------

export type RejectionCode =
  | "UNKNOWN_ACCOUNT"
  | "CURRENCY_MISMATCH"
  | "INVALID_AMOUNT"
  | "INVALID_VALUE_DATE"
  | "DUPLICATE_EVENT"
  | "UNKNOWN_AUTHORIZATION"
  | "AUTHORIZATION_NOT_APPROVED"
  | "DUPLICATE_AUTHORIZATION"
  | "SETTLEMENT_EXCEEDS_HOLD"
  | "UNKNOWN_REVERSAL_TARGET"
  | "REVERSAL_NOT_ALLOWED"
  | "ALREADY_REVERSED"
  | "OUTSIDE_WINDOW";

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export interface Rejection {
  readonly code: RejectionCode;
  readonly message: string;
}

export interface EventOutcome {
  readonly eventId: EventId;
  readonly accountId: AccountId;
  readonly bookingDay: Day;
  readonly status: "APPLIED" | "REJECTED";
  readonly rejection?: Rejection;
  /** Non-fatal notes, e.g. a late-arriving event booked on a later day. */
  readonly notices: readonly string[];
  readonly entries: readonly LedgerEntry[];
}

// ---------------------------------------------------------------------------
// Observability: injected, never global.
// ---------------------------------------------------------------------------

export type LogFields = Readonly<Record<string, string | number | boolean | bigint | undefined>>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

// ---------------------------------------------------------------------------
// End-of-day reporting and the restated (value-dated) view
// ---------------------------------------------------------------------------

/** Non-fatal end-of-day problem; the day still closes. */
export interface EodError {
  readonly code: "FEE_NOT_CONFIGURED";
  readonly accountId: AccountId;
  readonly day: Day;
}

export interface AccountDayReport {
  readonly accountId: AccountId;
  readonly currency: Currency;
  /** Balance by value date <= the closed day, after this end-of-day's fees and interest. */
  readonly closingLedgerMinor: bigint;
  readonly activeHoldsMinor: bigint;
  readonly availableMinor: bigint;
  /** Fee entries booked at this end-of-day (their value dates may be earlier days). */
  readonly feesAssessed: readonly LedgerEntry[];
  readonly interestCapitalized?: LedgerEntry;
}

/** The state of the ledger as known at the moment the day closed. */
export interface DayReport {
  readonly day: Day;
  readonly accounts: readonly AccountDayReport[];
  readonly authorizations: readonly Authorization[];
  /** Every event booked on this day, applied and rejected. */
  readonly outcomes: readonly EventOutcome[];
  readonly eodErrors: readonly EodError[];
}

export interface RestatedDay {
  readonly day: Day;
  /** Final value-dated closing balance including the capitalized interest entry. */
  readonly closingMinor: bigint;
  /** The balance the interest accrual was based on (captured at capitalization time). */
  readonly closingBeforeInterestMinor: bigint;
  readonly dailyAccrualMinor: bigint;
}

export interface RestatedAccount {
  readonly accountId: AccountId;
  readonly currency: Currency;
  readonly days: readonly RestatedDay[];
  /** Sum of INTEREST entries in the ledger for the account. */
  readonly capitalizedMinor: bigint;
  readonly accrualSumMinor: bigint;
  readonly accrualMatchesCapitalized: boolean;
}

export interface RestatedView {
  readonly accounts: readonly RestatedAccount[];
}

export interface ReplayResult {
  readonly dayReports: readonly DayReport[];
  readonly restated: RestatedView;
  readonly outcomes: readonly EventOutcome[];
}
