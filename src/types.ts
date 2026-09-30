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
  | "ALREADY_REVERSED";

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
