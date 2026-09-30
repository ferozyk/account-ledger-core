import { beforeEach, describe, expect, it } from "vitest";
import { AuthorizationBook } from "../../src/authorizations.js";
import type { Money, Rejection, Result } from "../../src/types.js";

const aed = (minor: bigint): Money => ({ currency: "AED", minor });
const bhd = (minor: bigint): Money => ({ currency: "BHD", minor });

function input(authId: string, amount: Money, accountId = "acc-1", day = 1) {
  return { authId, accountId, amount, day };
}

function unwrap<T>(result: Result<T, Rejection>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

function errorCode<T>(result: Result<T, Rejection>): string {
  if (result.ok) throw new Error("expected an error");
  return result.error.code;
}

describe("AuthorizationBook.request", () => {
  let book: AuthorizationBook;
  beforeEach(() => {
    book = new AuthorizationBook();
  });

  it("approves when available balance exactly covers the amount (boundary at zero)", () => {
    const auth = unwrap(book.request(input("a1", aed(20000n)), 20000n));
    expect(auth.status).toBe("APPROVED");
    expect(auth.requestedDay).toBe(1);
  });

  it("declines when the amount exceeds available balance by one minor unit", () => {
    const auth = unwrap(book.request(input("a1", aed(20000n)), 19999n));
    expect(auth.status).toBe("DECLINED");
  });

  it("records declined authorizations as history without holding funds", () => {
    book.request(input("a1", aed(20000n)), 0n);
    expect(book.get("a1")?.status).toBe("DECLINED");
    expect(book.activeHoldsMinor("acc-1")).toBe(0n);
  });

  it("rejects a duplicate authId regardless of status", () => {
    book.request(input("a1", aed(100n)), 0n); // declined
    expect(errorCode(book.request(input("a1", aed(100n)), 1000n))).toBe("DUPLICATE_AUTHORIZATION");
  });

  it.each([0n, -5n])("rejects a non-positive amount of %s", (minor) => {
    expect(errorCode(book.request(input("a1", aed(minor)), 1000n))).toBe("INVALID_AMOUNT");
    expect(book.get("a1")).toBeUndefined();
  });

  it("counts approved holds per account only", () => {
    book.request(input("a1", aed(200n), "acc-1"), 1000n);
    book.request(input("a2", aed(300n), "acc-1"), 1000n);
    book.request(input("a3", aed(999n), "acc-2"), 1000n);
    expect(book.activeHoldsMinor("acc-1")).toBe(500n);
    expect(book.activeHoldsMinor("acc-2")).toBe(999n);
    expect(book.activeHoldsMinor("acc-3")).toBe(0n);
  });

  it("lists authorizations in insertion order, overall and per account", () => {
    book.request(input("a1", aed(1n), "acc-1"), 10n);
    book.request(input("a2", aed(1n), "acc-2"), 10n);
    book.request(input("a3", aed(1n), "acc-1"), 10n);
    expect(book.all().map((a) => a.authId)).toEqual(["a1", "a2", "a3"]);
    expect(book.forAccount("acc-1").map((a) => a.authId)).toEqual(["a1", "a3"]);
  });
});

describe("AuthorizationBook.settle", () => {
  let book: AuthorizationBook;
  beforeEach(() => {
    book = new AuthorizationBook();
    book.request(input("a1", aed(20000n)), 50000n);
  });

  it("partially settles 185 of 200 AED, releasing the whole hold", () => {
    const { authorization, releasedHoldMinor } = unwrap(
      book.settle(input("a1", aed(18500n), "acc-1", 3)),
    );
    expect(authorization).toMatchObject({
      status: "SETTLED",
      settledAmountMinor: 18500n,
      settledDay: 3,
    });
    expect(releasedHoldMinor).toBe(20000n);
    expect(book.activeHoldsMinor("acc-1")).toBe(0n);
  });

  it("rejects over-settlement and keeps the hold active", () => {
    expect(errorCode(book.settle(input("a1", aed(20001n))))).toBe("SETTLEMENT_EXCEEDS_HOLD");
    expect(book.activeHoldsMinor("acc-1")).toBe(20000n);
    expect(book.get("a1")?.status).toBe("APPROVED");
  });

  it("rejects a second settlement of the same authorization", () => {
    unwrap(book.settle(input("a1", aed(100n))));
    expect(errorCode(book.settle(input("a1", aed(100n))))).toBe("AUTHORIZATION_NOT_APPROVED");
  });

  it("rejects settling a declined authorization", () => {
    book.request(input("a2", aed(100n)), 0n);
    expect(errorCode(book.settle(input("a2", aed(100n))))).toBe("AUTHORIZATION_NOT_APPROVED");
  });

  it("reports an unknown authorization", () => {
    expect(errorCode(book.settle(input("nope", aed(100n))))).toBe("UNKNOWN_AUTHORIZATION");
  });

  it("does not reveal another account's authorization", () => {
    expect(errorCode(book.settle(input("a1", aed(100n), "acc-2")))).toBe("UNKNOWN_AUTHORIZATION");
    expect(book.get("a1")?.status).toBe("APPROVED");
  });

  it("rejects a settlement in a different currency", () => {
    expect(errorCode(book.settle(input("a1", bhd(100n))))).toBe("CURRENCY_MISMATCH");
  });

  it.each([0n, -1n])("rejects a non-positive settlement amount of %s", (minor) => {
    expect(errorCode(book.settle(input("a1", aed(minor))))).toBe("INVALID_AMOUNT");
    expect(book.activeHoldsMinor("acc-1")).toBe(20000n);
  });

  it("never mutates authorization objects already handed out", () => {
    const approved = unwrap(book.request(input("a2", aed(500n)), 1000n));
    const snapshot = { ...approved };
    const settled = unwrap(book.settle(input("a2", aed(500n), "acc-1", 4))).authorization;
    expect(approved).toEqual(snapshot);
    expect(approved.status).toBe("APPROVED");
    expect(settled).not.toBe(approved);
    expect(book.get("a2")).toBe(settled);
  });
});
