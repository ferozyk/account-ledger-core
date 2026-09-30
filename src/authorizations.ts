import type {
  AccountId,
  Authorization,
  AuthId,
  Day,
  Money,
  Rejection,
  RejectionCode,
  Result,
} from "./types.js";

export interface AuthorizationInput {
  readonly authId: AuthId;
  readonly accountId: AccountId;
  readonly amount: Money;
  readonly day: Day;
}

export interface Settlement {
  readonly authorization: Authorization;
  readonly releasedHoldMinor: bigint;
}

function fail(code: RejectionCode, message: string): { ok: false; error: Rejection } {
  return { ok: false, error: { code, message } };
}

/** In-memory projection of authorizations. Stored objects are immutable and replaced on change. */
export class AuthorizationBook {
  private readonly byId = new Map<AuthId, Authorization>();

  request(
    input: AuthorizationInput,
    availableBalanceMinor: bigint,
  ): Result<Authorization, Rejection> {
    if (this.byId.has(input.authId)) {
      return fail("DUPLICATE_AUTHORIZATION", `Authorization ${input.authId} already exists`);
    }
    if (input.amount.minor <= 0n) {
      return fail("INVALID_AMOUNT", "Authorization amount must be positive");
    }
    const approved = availableBalanceMinor - input.amount.minor >= 0n;
    const authorization: Authorization = {
      authId: input.authId,
      accountId: input.accountId,
      amount: input.amount,
      status: approved ? "APPROVED" : "DECLINED",
      requestedDay: input.day,
    };
    this.byId.set(input.authId, authorization);
    return { ok: true, value: authorization };
  }

  settle(input: AuthorizationInput): Result<Settlement, Rejection> {
    const existing = this.byId.get(input.authId);
    if (existing?.accountId !== input.accountId) {
      return fail("UNKNOWN_AUTHORIZATION", `Unknown authorization ${input.authId}`);
    }
    if (existing.amount.currency !== input.amount.currency) {
      return fail("CURRENCY_MISMATCH", "Settlement currency differs from the authorization");
    }
    if (existing.status !== "APPROVED") {
      return fail("AUTHORIZATION_NOT_APPROVED", `Authorization is ${existing.status}`);
    }
    if (input.amount.minor <= 0n) {
      return fail("INVALID_AMOUNT", "Settlement amount must be positive");
    }
    if (input.amount.minor > existing.amount.minor) {
      return fail("SETTLEMENT_EXCEEDS_HOLD", "Settlement exceeds the authorized hold");
    }
    const authorization: Authorization = {
      ...existing,
      status: "SETTLED",
      settledAmountMinor: input.amount.minor,
      settledDay: input.day,
    };
    this.byId.set(input.authId, authorization);
    return { ok: true, value: { authorization, releasedHoldMinor: existing.amount.minor } };
  }

  /** Sum of approved, not yet settled holds for the account. */
  activeHoldsMinor(accountId: AccountId): bigint {
    return this.forAccount(accountId)
      .filter((auth) => auth.status === "APPROVED")
      .reduce((sum, auth) => sum + auth.amount.minor, 0n);
  }

  get(authId: AuthId): Authorization | undefined {
    return this.byId.get(authId);
  }

  all(): readonly Authorization[] {
    return [...this.byId.values()];
  }

  forAccount(accountId: AccountId): readonly Authorization[] {
    return this.all().filter((auth) => auth.accountId === accountId);
  }
}
