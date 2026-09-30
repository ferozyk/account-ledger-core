import { describe, expect, it } from "vitest";
import { LedgerEngine, type LedgerConfig } from "../../src/engine.js";
import { createRecordingLogger } from "../../src/logger.js";
import type { DayReport, EventOutcome, LedgerEvent, RejectionCode } from "../../src/types.js";
import {
  aed,
  authorization,
  bhd,
  credit,
  debit,
  makeConfig,
  reversal,
  settlement,
} from "../helpers.js";

function setup(config: LedgerConfig = makeConfig()) {
  const { logger, records } = createRecordingLogger();
  return { engine: new LedgerEngine(config, logger), records };
}

const codeOf = (outcome: EventOutcome): RejectionCode | undefined => outcome.rejection?.code;

function feeValueDates(engine: LedgerEngine, accountId = "A"): number[] {
  return engine
    .entries()
    .filter((entry) => entry.kind === "FEE" && entry.accountId === accountId)
    .map((entry) => entry.valueDate);
}

describe("validation order and rejection codes", () => {
  it("given an already seen event id, when it arrives again, then DUPLICATE_EVENT and no second posting", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("10.00")));

    const outcome = engine.process(credit("E1", 1, aed("99.00")));

    expect(codeOf(outcome)).toBe("DUPLICATE_EVENT");
    expect(engine.entries()).toHaveLength(1);
    expect(engine.outcomes()).toHaveLength(2);
  });

  it("given a rejected event, when its id is reused, then it is still a duplicate", () => {
    const { engine } = setup();
    expect(codeOf(engine.process(credit("E1", 1, aed("0.00"))))).toBe("INVALID_AMOUNT");

    expect(codeOf(engine.process(credit("E1", 1, aed("5.00"))))).toBe("DUPLICATE_EVENT");
    expect(engine.entries()).toHaveLength(0);
  });

  it("given a duplicate id on an unknown account, when processed, then duplicate wins over unknown account", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("1.00")));

    const outcome = engine.process(credit("E1", 1, aed("1.00"), { accountId: "NOPE" }));

    expect(codeOf(outcome)).toBe("DUPLICATE_EVENT");
  });

  it("given an unknown account, when an event arrives, then UNKNOWN_ACCOUNT", () => {
    const { engine } = setup();
    const outcome = engine.process(credit("E1", 1, aed("1.00"), { accountId: "NOPE" }));
    expect(codeOf(outcome)).toBe("UNKNOWN_ACCOUNT");
    expect(outcome.entries).toEqual([]);
  });

  it("given a day beyond the window, when an event arrives, then OUTSIDE_WINDOW without advancing time", () => {
    const { engine } = setup();
    const outcome = engine.process(credit("E1", 7, aed("1.00"), { valueDate: 1 }));
    expect(codeOf(outcome)).toBe("OUTSIDE_WINDOW");
    expect(engine.currentDay).toBe(1);
  });

  it("given a non-positive or fractional event day, when processed, then OUTSIDE_WINDOW", () => {
    const { engine } = setup();
    expect(codeOf(engine.process(credit("E1", 0, aed("1.00"), { valueDate: 1 })))).toBe(
      "OUTSIDE_WINDOW",
    );
    expect(codeOf(engine.process(credit("E2", 1.5, aed("1.00"), { valueDate: 1 })))).toBe(
      "OUTSIDE_WINDOW",
    );
  });

  it("given a value date after the booking day, when processed, then INVALID_VALUE_DATE", () => {
    const { engine } = setup();
    const outcome = engine.process(credit("E1", 2, aed("1.00"), { valueDate: 3 }));
    expect(codeOf(outcome)).toBe("INVALID_VALUE_DATE");
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "given value date %s, when processed, then INVALID_VALUE_DATE",
    (valueDate) => {
      const { engine } = setup();
      expect(codeOf(engine.process(credit("E1", 2, aed("1.00"), { valueDate })))).toBe(
        "INVALID_VALUE_DATE",
      );
    },
  );

  it("given an event currency that differs from the account, when processed, then CURRENCY_MISMATCH", () => {
    const { engine } = setup();
    const outcome = engine.process(credit("E1", 1, bhd("1.000")));
    expect(codeOf(outcome)).toBe("CURRENCY_MISMATCH");
  });

  it("given zero amounts, when credit or debit arrives, then INVALID_AMOUNT and nothing is posted", () => {
    const { engine } = setup();
    expect(codeOf(engine.process(credit("E1", 1, aed("0.00"))))).toBe("INVALID_AMOUNT");
    expect(codeOf(engine.process(debit("E2", 1, aed("0.00"))))).toBe("INVALID_AMOUNT");
    expect(engine.entries()).toHaveLength(0);
  });

  it.each([0, -2, 1.5, 4])(
    "given instalments %s for a 0.03 credit, when processed, then INVALID_AMOUNT",
    (n) => {
      const { engine } = setup();
      const outcome = engine.process(credit("E1", 1, aed("0.03"), { instalments: n }));
      expect(codeOf(outcome)).toBe("INVALID_AMOUNT");
      expect(engine.entries()).toHaveLength(0);
    },
  );

  it("given a zero authorization amount and a repeated auth id, when processed, then the book's errors are rejections", () => {
    const { engine } = setup();
    expect(codeOf(engine.process(authorization("E1", 1, "X", aed("0.00"))))).toBe("INVALID_AMOUNT");
    engine.process(credit("E2", 1, aed("10.00")));
    engine.process(authorization("E3", 1, "Y", aed("1.00")));
    expect(codeOf(engine.process(authorization("E4", 1, "Y", aed("1.00"))))).toBe(
      "DUPLICATE_AUTHORIZATION",
    );
  });

  it("given rejected events, when a day closes, then the day report lists them with their codes", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("1.00")));
    engine.process(credit("E2", 1, aed("0.00")));

    const report = engine.closeDay();

    expect(report.outcomes.map((o) => [o.eventId, o.status, codeOf(o)])).toEqual([
      ["E1", "APPLIED", undefined],
      ["E2", "REJECTED", "INVALID_AMOUNT"],
    ]);
  });
});

describe("postings", () => {
  it("given a credit in instalments, when processed, then one entry per instalment summing to the amount", () => {
    const { engine } = setup();
    const outcome = engine.process(
      credit("E1", 1, bhd("10.000"), { accountId: "B", instalments: 3 }),
    );
    expect(outcome.entries.map((e) => e.amountMinor)).toEqual([3334n, 3333n, 3333n]);
    expect(new Set(outcome.entries.map((e) => e.valueDate))).toEqual(new Set([1]));
  });

  it("given a debit exceeding the balance, when processed, then it is accepted as an overdraft", () => {
    const { engine } = setup();
    const outcome = engine.process(debit("E1", 1, aed("5.00")));
    expect(outcome.status).toBe("APPLIED");
    expect(engine.closingBalance("A", 1)).toBe(-500n);
  });
});

describe("reversals", () => {
  it("given an applied multi-entry credit, when reversed, then every entry is compensated and linked", () => {
    const { engine } = setup();
    const original = engine.process(
      credit("E1", 1, bhd("0.010"), { accountId: "B", instalments: 2 }),
    );

    const outcome = engine.process(reversal("R1", 2, "E1", { accountId: "B", valueDate: 1 }));

    expect(
      outcome.entries.map((e) => [
        e.kind,
        e.amountMinor,
        e.reversesEntryId,
        e.sourceEventId,
        e.bookingDay,
      ]),
    ).toEqual(original.entries.map((e) => ["REVERSAL", -e.amountMinor, e.entryId, "R1", 2]));
    expect(engine.closingBalance("B", 2)).toBe(0n);
  });

  it("given an unknown target, when reversed, then UNKNOWN_REVERSAL_TARGET", () => {
    const { engine } = setup();
    expect(codeOf(engine.process(reversal("R1", 1, "GHOST")))).toBe("UNKNOWN_REVERSAL_TARGET");
  });

  it("given a rejected target, when reversed, then REVERSAL_NOT_ALLOWED", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("0.00")));
    expect(codeOf(engine.process(reversal("R1", 1, "E1")))).toBe("REVERSAL_NOT_ALLOWED");
  });

  it("given an authorization target, when reversed, then REVERSAL_NOT_ALLOWED", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("10.00")));
    engine.process(authorization("E2", 1, "X", aed("1.00")));
    expect(codeOf(engine.process(reversal("R1", 1, "E2")))).toBe("REVERSAL_NOT_ALLOWED");
  });

  it("given a reversal as target, when reversed, then REVERSAL_NOT_ALLOWED", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("10.00")));
    engine.process(reversal("R1", 1, "E1"));
    expect(codeOf(engine.process(reversal("R2", 1, "R1")))).toBe("REVERSAL_NOT_ALLOWED");
  });

  it("given a target on another account, when reversed, then REVERSAL_NOT_ALLOWED", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("10.00")));
    const outcome = engine.process(reversal("R1", 1, "E1", { accountId: "B" }));
    expect(codeOf(outcome)).toBe("REVERSAL_NOT_ALLOWED");
  });

  it("given a different value date, when reversed, then REVERSAL_NOT_ALLOWED", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("10.00")));
    const outcome = engine.process(reversal("R1", 2, "E1", { valueDate: 2 }));
    expect(codeOf(outcome)).toBe("REVERSAL_NOT_ALLOWED");
    expect(engine.closingBalance("A", 2)).toBe(1000n);
  });

  it("given an already reversed target, when reversed again, then ALREADY_REVERSED and no extra entry", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("10.00")));
    engine.process(reversal("R1", 1, "E1"));
    const outcome = engine.process(reversal("R2", 1, "E1"));
    expect(codeOf(outcome)).toBe("ALREADY_REVERSED");
    expect(engine.entries()).toHaveLength(2);
  });

  it("given a rejected reversal, when the target is reversed correctly afterwards, then it is accepted", () => {
    const { engine } = setup();
    engine.process(credit("E1", 2, aed("10.00"), { valueDate: 2 }));
    engine.process(reversal("R1", 2, "E1", { valueDate: 1 }));
    expect(engine.process(reversal("R2", 2, "E1", { valueDate: 2 })).status).toBe("APPLIED");
  });
});

describe("authorizations and settlements", () => {
  it("given an approval to exactly zero available, when a second authorization follows, then its hold blocks it", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("100.00")));
    engine.process(authorization("E2", 1, "A1", aed("100.00")));
    const second = engine.process(authorization("E3", 1, "A2", aed("0.01")));

    const report = engine.closeDay();

    expect(report.authorizations.map((a) => [a.authId, a.status])).toEqual([
      ["A1", "APPROVED"],
      ["A2", "DECLINED"],
    ]);
    expect(second.notices).toEqual(["authorization A2 declined: available 0.00, requested 0.01"]);
    expect(second.status).toBe("APPLIED");
    expect(report.accounts[0]).toMatchObject({ activeHoldsMinor: 10000n, availableMinor: 0n });
  });

  it("given an approved hold, when settled, then the hold is released and funds leave by value date", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("100.00")));
    engine.process(authorization("E2", 1, "A1", aed("60.00")));

    const outcome = engine.process(settlement("E3", 1, "A1", aed("55.00")));
    const report = engine.closeDay();

    expect(outcome.entries.map((e) => [e.kind, e.amountMinor])).toEqual([["SETTLEMENT", -5500n]]);
    expect(report.accounts[0]).toMatchObject({
      closingLedgerMinor: 4500n,
      activeHoldsMinor: 0n,
      availableMinor: 4500n,
    });
    expect(report.authorizations[0]).toMatchObject({
      status: "SETTLED",
      settledAmountMinor: 5500n,
      settledDay: 1,
    });
  });

  it.each([
    ["an unknown authorization", settlement("E3", 1, "NOPE", aed("1.00")), "UNKNOWN_AUTHORIZATION"],
    ["more than the hold", settlement("E3", 1, "A1", aed("61.00")), "SETTLEMENT_EXCEEDS_HOLD"],
    ["a zero amount", settlement("E3", 1, "A1", aed("0.00")), "INVALID_AMOUNT"],
  ] as [string, LedgerEvent, RejectionCode][])(
    "given a settlement for %s, when processed, then %s rejects it and balances are unchanged",
    (_label, event, code) => {
      const { engine } = setup();
      engine.process(credit("E1", 1, aed("100.00")));
      engine.process(authorization("E2", 1, "A1", aed("60.00")));
      const entriesBefore = engine.entries();

      const outcome = engine.process(event);
      const report = engine.closeDay();

      expect(codeOf(outcome)).toBe(code);
      expect(engine.entries()).toEqual(entriesBefore);
      expect(report.accounts[0]).toMatchObject({
        closingLedgerMinor: 10000n,
        activeHoldsMinor: 6000n,
      });
    },
  );

  it("given a settled authorization, when settled again, then AUTHORIZATION_NOT_APPROVED", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("100.00")));
    engine.process(authorization("E2", 1, "A1", aed("60.00")));
    engine.process(settlement("E3", 1, "A1", aed("60.00")));
    expect(codeOf(engine.process(settlement("E4", 1, "A1", aed("1.00"))))).toBe(
      "AUTHORIZATION_NOT_APPROVED",
    );
  });
});

describe("end of day fees", () => {
  function overdrawnWithCascade() {
    // Given day 1 = 100.00, day 2 = 110.00, then a back-valued debit on day 3 leaves day 1 at -5.00
    // and day 2 at +5.00: both positive days only go negative once earlier fees cascade.
    const setupResult = setup();
    const { engine } = setupResult;
    engine.process(credit("E1", 1, aed("100.00")));
    engine.closeDay();
    engine.process(credit("E2", 2, aed("10.00")));
    engine.closeDay();
    engine.process(debit("E3", 3, aed("105.00"), { valueDate: 1 }));
    return setupResult;
  }

  it("given a back-valued debit, when the day closes, then fees cascade over every affected value day", () => {
    const { engine } = overdrawnWithCascade();
    expect(engine.closingBalance("A", 1)).toBe(-500n);

    const report = engine.closeDay();

    expect(
      report.accounts[0]?.feesAssessed.map((f) => [f.valueDate, f.bookingDay, f.amountMinor]),
    ).toEqual([
      [1, 3, -2500n],
      [2, 3, -2500n],
      [3, 3, -2500n],
    ]);
    expect(report.accounts[0]?.feesAssessed.every((f) => f.sourceEventId === undefined)).toBe(true);
    expect(engine.closingBalance("A", 1)).toBe(-3000n);
  });

  it("given fees already charged, when later days close, then no value day is charged twice", () => {
    const { engine } = overdrawnWithCascade();
    engine.closeDay();

    const next = engine.closeDay();

    expect(next.accounts[0]?.feesAssessed.map((f) => f.valueDate)).toEqual([4]);
    expect(feeValueDates(engine)).toEqual([1, 2, 3, 4]);
    expect(engine.closeDay().accounts[0]?.feesAssessed.map((f) => f.valueDate)).toEqual([5]);
    expect(feeValueDates(engine)).toEqual([1, 2, 3, 4, 5]);
  });

  it("given a non-overdrawn account, when days close, then no fee is charged", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("10.00")));
    engine.closeWindow();
    expect(feeValueDates(engine)).toEqual([]);
  });

  it("given an overdrawn account with no fee for its currency, when the day closes, then FEE_NOT_CONFIGURED is reported and logged", () => {
    const { engine, records } = setup();
    engine.process(debit("E1", 1, bhd("1.000"), { accountId: "B" }));

    const report: DayReport = engine.closeDay();

    expect(report.eodErrors).toEqual([{ code: "FEE_NOT_CONFIGURED", accountId: "B", day: 1 }]);
    expect(feeValueDates(engine, "B")).toEqual([]);
    expect(records.find((r) => r.event === "fee.not_configured")).toMatchObject({
      level: "error",
      fields: { accountId: "B", day: 1 },
    });
  });

  it("given a fee of zero in the config, when the engine is created, then it refuses", () => {
    expect(() => setup(makeConfig({ overdraftFeeMinor: { AED: 0n } }))).toThrow(RangeError);
  });

  it("given a fee, when assessed, then it is logged with value date, booking day and amount", () => {
    const { engine, records } = setup();
    engine.process(debit("E1", 1, aed("1.00")));
    engine.closeDay();
    expect(records.find((r) => r.event === "fee.assessed")?.fields).toEqual({
      accountId: "A",
      valueDate: 1,
      bookingDay: 1,
      amountMinor: -2500n,
    });
  });
});

describe("time", () => {
  it("given a day that already closed, when its event arrives late, then it is booked on the current day with a notice", () => {
    const { engine, records } = setup();
    engine.advanceTo(3);

    const outcome = engine.process(credit("E1", 1, aed("10.00"), { valueDate: 1 }));

    expect(outcome.status).toBe("APPLIED");
    expect(outcome.bookingDay).toBe(3);
    expect(outcome.notices).toEqual(["arrived for day 1 after day 1 closed; booked on day 3"]);
    expect(outcome.entries[0]).toMatchObject({ bookingDay: 3, valueDate: 1 });
    expect(records.find((r) => r.event === "event.late")).toMatchObject({
      level: "warn",
      fields: { eventId: "E1", eventDay: 1, bookingDay: 3 },
    });
    expect(engine.closeDay().outcomes.map((o) => o.eventId)).toEqual(["E1"]);
  });

  it("given a late event, when a future value date relative to the current day is used, then it is still rejected", () => {
    const { engine } = setup();
    engine.advanceTo(3);
    const outcome = engine.process(credit("E1", 1, aed("10.00"), { valueDate: 4 }));
    expect(codeOf(outcome)).toBe("INVALID_VALUE_DATE");
  });

  it("given a full window, when closing another day, then it throws", () => {
    const { engine } = setup();
    expect(engine.closeWindow()).toHaveLength(6);
    expect(() => engine.closeDay()).toThrow(/closed/);
  });

  it("given an open window, when the restated view is requested, then it throws", () => {
    const { engine } = setup();
    expect(() => engine.restatedView()).toThrow(/closed/);
  });

  it("given a closed window, when an event arrives, then OUTSIDE_WINDOW", () => {
    const { engine } = setup();
    engine.closeWindow();
    expect(codeOf(engine.process(credit("E1", 6, aed("1.00"))))).toBe("OUTSIDE_WINDOW");
  });

  it("given events beyond the window, when advancing, then the last day is left open", () => {
    const { engine } = setup();
    engine.advanceTo(99);
    expect(engine.currentDay).toBe(6);
  });
});

describe("interest on the last day", () => {
  it("given a positive balance, when the window closes, then interest follows fees and is non-circular", () => {
    const { engine } = setup();
    engine.process(credit("E1", 1, aed("1000.00")));
    engine.closeWindow();

    const view = engine.restatedView().accounts[0];

    // 1000.00 * 0.0004 = 0.40 per day for six days
    expect(view?.capitalizedMinor).toBe(240n);
    expect(view?.days.map((d) => d.dailyAccrualMinor)).toEqual([40n, 40n, 40n, 40n, 40n, 40n]);
    expect(view?.days[5]).toMatchObject({
      closingBeforeInterestMinor: 100000n,
      closingMinor: 100240n,
    });
    expect(view?.accrualMatchesCapitalized).toBe(true);
  });

  it("given no positive balance, when the window closes, then no interest entry is written", () => {
    const { engine } = setup();
    engine.closeWindow();
    expect(engine.entries().filter((e) => e.kind === "INTEREST")).toEqual([]);
    expect(engine.restatedView().accounts[0]?.capitalizedMinor).toBe(0n);
  });
});

describe("append-only ledger", () => {
  it("given more processing, when entries are read again, then earlier entries are unchanged and the count only grows", () => {
    const { engine } = setup();
    const events: LedgerEvent[] = [
      credit("E1", 1, aed("100.00")),
      debit("E2", 1, aed("150.00")),
      credit("E3", 1, aed("0.00")),
      reversal("R1", 1, "E2"),
    ];
    let previous = engine.entries();
    for (const event of events) {
      engine.process(event);
      engine.closeDay();
      const current = engine.entries();
      expect(current.length).toBeGreaterThanOrEqual(previous.length);
      expect(current.slice(0, previous.length)).toEqual(previous);
      previous = current;
    }
    expect(previous.length).toBeGreaterThan(3);
  });
});

describe("logging", () => {
  it("given a rejection, when logged, then it carries eventId and code but no amounts", () => {
    const { engine, records } = setup();
    engine.process(credit("E1", 1, aed("0.00")));

    const record = records.find((r) => r.event === "event.rejected");

    expect(record?.level).toBe("warn");
    expect(record?.fields).toEqual({ eventId: "E1", accountId: "A", code: "INVALID_AMOUNT" });
  });

  it("given an applied event, when logged, then it carries eventId, account and type", () => {
    const { engine, records } = setup();
    engine.process(credit("E1", 1, aed("1.00")));
    expect(records.find((r) => r.event === "event.applied")).toMatchObject({
      level: "info",
      fields: { eventId: "E1", accountId: "A", type: "CREDIT" },
    });
  });

  it("given a declined authorization, when processed, then authorization.declined is logged with the event id", () => {
    const { engine, records } = setup();
    engine.process(authorization("E1", 1, "A1", aed("1.00")));
    expect(records.find((r) => r.event === "authorization.declined")?.fields).toMatchObject({
      eventId: "E1",
    });
  });

  it("given every log record, when inspected, then none holds an amount field other than fees and interest", () => {
    const { engine, records } = setup();
    engine.process(credit("E1", 1, aed("10.00")));
    engine.process(credit("E2", 1, aed("0.00")));
    engine.closeWindow();
    const offenders = records.filter(
      (r) =>
        "amount" in r.fields || ("amountMinor" in r.fields && !/^(fee|interest)\./.test(r.event)),
    );
    expect(offenders).toEqual([]);
  });
});
