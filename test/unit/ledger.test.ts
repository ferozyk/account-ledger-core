import { describe, it, expect } from "vitest";
import { Ledger, type EntryDraft } from "../../src/ledger.js";
import type { Account } from "../../src/types.js";

const ACCOUNTS: Account[] = [
  { id: "A1", currency: "AED", openingBalanceMinor: 100000n },
  { id: "B1", currency: "BHD", openingBalanceMinor: 0n },
];

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return {
    accountId: "A1",
    currency: "AED",
    kind: "CREDIT",
    amountMinor: 1000n,
    valueDate: 1,
    bookingDay: 1,
    ...overrides,
  };
}

describe("Ledger construction", () => {
  it("given duplicate account ids, when constructed, then it throws", () => {
    expect(() => new Ledger([...ACCOUNTS, ...ACCOUNTS])).toThrow(/Duplicate/);
  });

  it("given accounts, when queried, then they are returned by id and in order", () => {
    const ledger = new Ledger(ACCOUNTS);
    expect(ledger.account("B1")).toEqual(ACCOUNTS[1]);
    expect(ledger.account("missing")).toBeUndefined();
    expect(ledger.accounts().map((a) => a.id)).toEqual(["A1", "B1"]);
  });
});

describe("Ledger.append", () => {
  it("given valid drafts, when appended, then ids are sequential and zero-padded", () => {
    const ledger = new Ledger(ACCOUNTS);
    const stored = ledger.append([draft(), draft({ amountMinor: -5n })]);
    expect(stored.map((e) => e.entryId)).toEqual(["L0001", "L0002"]);
    expect(ledger.append([draft()])[0]?.entryId).toBe("L0003");
  });

  it("given more than 9999 entries, when appended, then ids keep growing", () => {
    const ledger = new Ledger(ACCOUNTS);
    ledger.append(Array.from({ length: 9999 }, () => draft()));
    expect(ledger.append([draft()])[0]?.entryId).toBe("L10000");
  });

  it("given a stored entry, when mutation is attempted, then it is frozen", () => {
    const [entry] = new Ledger(ACCOUNTS).append([draft()]);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { amountMinor: bigint }).amountMinor = 1n;
    }).toThrow(TypeError);
  });

  it("given a later draft is invalid, when a batch is appended, then nothing is stored", () => {
    const ledger = new Ledger(ACCOUNTS);
    expect(() => ledger.append([draft(), draft({ amountMinor: 0n })])).toThrow();
    expect(ledger.entries()).toEqual([]);
    expect(ledger.closingBalance("A1", 10)).toBe(100000n);
    expect(ledger.append([draft()])[0]?.entryId).toBe("L0001");
  });

  it.each<[string, Partial<EntryDraft>]>([
    ["unknown account", { accountId: "nope" }],
    ["currency mismatch", { currency: "BHD" }],
    ["zero amount", { amountMinor: 0n }],
    ["zero value date", { valueDate: 0, bookingDay: 1 }],
    ["fractional value date", { valueDate: 1.5, bookingDay: 2 }],
    ["zero booking day", { valueDate: 1, bookingDay: 0 }],
    ["future value date", { valueDate: 3, bookingDay: 2 }],
  ])("given %s, when appended, then it throws", (_name, overrides) => {
    expect(() => new Ledger(ACCOUNTS).append([draft(overrides)])).toThrow();
  });

  it("given value date equal to booking day, when appended, then it is accepted", () => {
    expect(() =>
      new Ledger(ACCOUNTS).append([draft({ valueDate: 4, bookingDay: 4 })]),
    ).not.toThrow();
  });
});

describe("Ledger queries", () => {
  function populated(): Ledger {
    const ledger = new Ledger(ACCOUNTS);
    ledger.append([
      draft({ sourceEventId: "E1" }),
      draft({ accountId: "B1", currency: "BHD", sourceEventId: "E2" }),
      draft({ amountMinor: -200n, kind: "DEBIT", sourceEventId: "E1" }),
    ]);
    return ledger;
  }

  it("given entries on two accounts, when filtered, then only matching entries return in order", () => {
    const ledger = populated();
    expect(ledger.entries()).toHaveLength(3);
    expect(ledger.entriesForAccount("A1").map((e) => e.entryId)).toEqual(["L0001", "L0003"]);
    expect(ledger.entriesForSourceEvent("E1").map((e) => e.entryId)).toEqual(["L0001", "L0003"]);
    expect(ledger.entriesForAccount("unknown")).toEqual([]);
    expect(ledger.entriesForSourceEvent("unknown")).toEqual([]);
  });

  it("given a returned array, when it is mutated, then ledger state is unaffected", () => {
    const ledger = populated();
    for (const view of [
      ledger.entries(),
      ledger.entriesForAccount("A1"),
      ledger.entriesForSourceEvent("E1"),
      ledger.accounts(),
    ]) {
      (view as unknown[]).length = 0;
    }
    expect(ledger.entries()).toHaveLength(3);
    expect(ledger.entriesForAccount("A1")).toHaveLength(2);
    expect(ledger.entriesForSourceEvent("E1")).toHaveLength(2);
    expect(ledger.accounts()).toHaveLength(2);
  });

  it("given the public API, when inspected, then there is no update or remove method", () => {
    const methods = Object.getOwnPropertyNames(Ledger.prototype);
    expect(methods.filter((m) => /remove|delete|update|set|clear|edit/i.test(m))).toEqual([]);
  });
});

describe("Ledger balances", () => {
  it("given no entries, when closing balance is read, then it is the opening balance", () => {
    expect(new Ledger(ACCOUNTS).closingBalance("A1", 5)).toBe(100000n);
  });

  it("given entries on several value days, when balance is read, then only entries up to that day count", () => {
    const ledger = new Ledger(ACCOUNTS);
    ledger.append([
      draft({ amountMinor: 500n, valueDate: 2, bookingDay: 2 }),
      draft({ amountMinor: -200n, valueDate: 4, bookingDay: 4 }),
    ]);
    expect(ledger.closingBalance("A1", 1)).toBe(100000n);
    expect(ledger.closingBalance("A1", 2)).toBe(100500n);
    expect(ledger.closingBalance("A1", 3)).toBe(100500n);
    expect(ledger.closingBalance("A1", 4)).toBe(100300n);
  });

  it("given a back-valued entry booked later, when balance is read, then the earlier day changes", () => {
    const ledger = new Ledger(ACCOUNTS);
    ledger.append([draft({ amountMinor: -300n, valueDate: 5, bookingDay: 5 })]);
    const before = ledger.closingBalance("A1", 3);
    ledger.append([draft({ amountMinor: 700n, valueDate: 3, bookingDay: 5 })]);
    expect(before).toBe(100000n);
    expect(ledger.closingBalance("A1", 3)).toBe(100700n);
    expect(ledger.closingBalance("A1", 5)).toBe(100400n);
  });

  it("given an unknown account, when balances are read, then it throws", () => {
    const ledger = new Ledger(ACCOUNTS);
    expect(() => ledger.closingBalance("nope", 1)).toThrow();
    expect(() => ledger.closingBalances("nope", 1)).toThrow();
  });

  it("given mixed entries, when closingBalances is read, then it agrees with closingBalance on every day", () => {
    const ledger = new Ledger(ACCOUNTS);
    ledger.append([
      draft({ amountMinor: 500n, valueDate: 2, bookingDay: 2 }),
      draft({ amountMinor: -200n, valueDate: 4, bookingDay: 6 }),
      draft({ amountMinor: 50n, valueDate: 2, bookingDay: 7 }),
      draft({ amountMinor: -10n, valueDate: 7, bookingDay: 7 }),
    ]);
    const series = ledger.closingBalances("A1", 9);
    expect(series).toHaveLength(9);
    series.forEach((balance, index) => {
      expect(balance).toBe(ledger.closingBalance("A1", index + 1));
    });
    expect(series[8]).toBe(100340n);
  });

  it("given throughDay of 0, when closingBalances is read, then the series is empty", () => {
    expect(new Ledger(ACCOUNTS).closingBalances("A1", 0)).toEqual([]);
  });

  it("given entries valued after throughDay, when closingBalances is read, then they are excluded", () => {
    const ledger = new Ledger(ACCOUNTS);
    ledger.append([draft({ valueDate: 8, bookingDay: 8 })]);
    expect(ledger.closingBalances("A1", 3)).toEqual([100000n, 100000n, 100000n]);
  });

  it("given an invalid throughDay, when closingBalances is read, then it throws RangeError", () => {
    const ledger = new Ledger(ACCOUNTS);
    expect(() => ledger.closingBalances("A1", -1)).toThrow(RangeError);
    expect(() => ledger.closingBalances("A1", 1.5)).toThrow(RangeError);
  });
});
