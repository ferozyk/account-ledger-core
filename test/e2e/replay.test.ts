import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LedgerEngine, replay } from "../../src/engine.js";
import { createJsonLogger, noopLogger } from "../../src/logger.js";
import { formatReplay } from "../../src/report.js";
import { SCENARIO_CONFIG, SCENARIO_EVENTS } from "../../src/scenario.js";
import type { DayReport, ReplayResult } from "../../src/types.js";

const result: ReplayResult = replay(SCENARIO_CONFIG, SCENARIO_EVENTS, noopLogger);

function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}
const day = (n: number): DayReport => found(result.dayReports[n - 1], `day ${n}`);
const account = (n: number, id: string) =>
  found(
    day(n).accounts.find((a) => a.accountId === id),
    `account ${id}`,
  );
const outcome = (id: string) =>
  found(
    result.outcomes.find((o) => o.eventId === id),
    `outcome ${id}`,
  );

describe("scenario replay (in process)", () => {
  it("given the scenario, when replayed, then six day reports are produced in order", () => {
    expect(result.dayReports.map((r) => r.day)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.outcomes).toHaveLength(10);
  });

  it("given day 1 to 4, when closed, then balances, holds and availability match", () => {
    const acc = (n: number) => account(n, "ACC-001");
    expect(acc(1)).toMatchObject({ closingLedgerMinor: 25000n, activeHoldsMinor: 0n });
    expect(acc(2)).toMatchObject({
      closingLedgerMinor: 25000n,
      activeHoldsMinor: 20000n,
      availableMinor: 5000n,
    });
    expect(acc(3)).toMatchObject({
      closingLedgerMinor: 65000n,
      activeHoldsMinor: 20000n,
      availableMinor: 45000n,
    });
    expect(acc(4)).toMatchObject({
      closingLedgerMinor: 46500n,
      activeHoldsMinor: 0n,
      availableMinor: 46500n,
    });
    expect([1, 2, 3, 4].map((n) => acc(n).feesAssessed.length)).toEqual([0, 0, 0, 0]);
  });

  it("given the authorizations, when settled or unknown, then statuses and entries match", () => {
    expect(day(2).authorizations.find((a) => a.authId === "Auth-A")?.status).toBe("APPROVED");
    expect(outcome("E3")).toMatchObject({ status: "APPLIED", entries: [] });
    expect(outcome("E3").notices).toEqual([
      "authorization Auth-A approved, hold placed: available 250.00, requested 200.00",
    ]);

    expect(day(4).authorizations[0]).toMatchObject({
      authId: "Auth-A",
      status: "SETTLED",
      settledAmountMinor: 18500n,
      settledDay: 4,
    });
    expect(outcome("E5").entries.map((e) => [e.kind, e.amountMinor, e.valueDate])).toEqual([
      ["SETTLEMENT", -18500n, 4],
    ]);
    expect(outcome("E6")).toMatchObject({ status: "REJECTED", entries: [] });
    expect(outcome("E6").rejection?.code).toBe("UNKNOWN_AUTHORIZATION");
  });

  it("given day 5, when E7 back-values and Auth-B is requested, then Auth-B is declined and fees cascade", () => {
    expect(outcome("E7")).toMatchObject({ status: "APPLIED", bookingDay: 5 });
    expect(outcome("E7").entries[0]).toMatchObject({ amountMinor: -62000n, valueDate: 2 });

    expect(outcome("E8").status).toBe("APPLIED");
    expect(outcome("E8").notices).toEqual([
      "authorization Auth-B declined: available -155.00, requested 90.00",
    ]);
    expect(day(5).authorizations.find((a) => a.authId === "Auth-B")?.status).toBe("DECLINED");

    const fees = account(5, "ACC-001").feesAssessed;
    expect(fees.map((f) => [f.valueDate, f.bookingDay, f.amountMinor])).toEqual([
      [2, 5, -2500n],
      [4, 5, -2500n],
      [5, 5, -2500n],
    ]);
    expect(account(5, "ACC-001")).toMatchObject({
      closingLedgerMinor: -23000n,
      availableMinor: -23000n,
    });
    expect(account(5, "ACC-002")).toMatchObject({ closingLedgerMinor: 0n });
  });

  it("given the day-2 balance after E7, when read before the EOD fees, then it is -370.00", () => {
    const engine = new LedgerEngine(SCENARIO_CONFIG, noopLogger);
    for (const event of SCENARIO_EVENTS.filter((e) => e.day <= 5 && e.id !== "E10")) {
      engine.advanceTo(event.day);
      engine.process(event);
    }
    expect(engine.currentDay).toBe(5);
    expect(engine.closingBalance("ACC-001", 2)).toBe(-37000n);
    expect(engine.closingBalance("ACC-001", 5)).toBe(-15500n);
  });

  it("given day 6, when E9 and the late E10 arrive, then both are applied with the right notices and postings", () => {
    expect(outcome("E9").entries[0]).toMatchObject({
      kind: "REVERSAL",
      amountMinor: 62000n,
      valueDate: 2,
      bookingDay: 6,
    });
    expect(outcome("E9").entries[0]?.reversesEntryId).toBe(outcome("E7").entries[0]?.entryId);

    const e10 = outcome("E10");
    expect(e10.bookingDay).toBe(6);
    expect(e10.notices).toEqual(["arrived for day 5 after day 5 closed; booked on day 6"]);
    expect(e10.entries.map((e) => [e.kind, e.amountMinor, e.valueDate])).toEqual([
      ["CREDIT", 3334n, 5],
      ["CREDIT", 3333n, 5],
      ["CREDIT", 3333n, 5],
    ]);
    expect(day(6).accounts.flatMap((a) => a.feesAssessed)).toEqual([]);
    expect(day(6).outcomes.map((o) => o.eventId)).toEqual(["E9", "E10"]);
  });

  it("given the window closed, when restated, then ACC-001 closings and accruals match", () => {
    const view = found(result.restated.accounts[0], "ACC-001 view");

    expect(view.days.map((d) => d.closingBeforeInterestMinor)).toEqual([
      25000n,
      22500n,
      62500n,
      41500n,
      39000n,
      39000n,
    ]);
    expect(view.days.map((d) => d.dailyAccrualMinor)).toEqual([10n, 9n, 25n, 17n, 16n, 16n]);
    expect(view.days.map((d) => d.closingMinor)).toEqual([
      25000n,
      22500n,
      62500n,
      41500n,
      39000n,
      39093n,
    ]);
    expect(view.capitalizedMinor).toBe(93n);
    expect(view.accrualMatchesCapitalized).toBe(true);
  });

  it("given the window closed, when restated, then ACC-002 closings and accruals match", () => {
    const view = found(result.restated.accounts[1], "ACC-002 view");

    expect(view.days.map((d) => d.closingBeforeInterestMinor)).toEqual([
      0n,
      0n,
      0n,
      0n,
      10000n,
      10000n,
    ]);
    expect(view.days.map((d) => d.dailyAccrualMinor)).toEqual([0n, 0n, 0n, 0n, 4n, 4n]);
    expect(view.days.map((d) => d.closingMinor)).toEqual([0n, 0n, 0n, 0n, 10000n, 10008n]);
    expect(view.capitalizedMinor).toBe(8n);
    expect(view.accrualMatchesCapitalized).toBe(true);
  });

  it("given the day 6 report, when interest is capitalized, then the reported closings include it", () => {
    expect(account(6, "ACC-001")).toMatchObject({ closingLedgerMinor: 39093n });
    expect(account(6, "ACC-001").interestCapitalized).toMatchObject({
      kind: "INTEREST",
      amountMinor: 93n,
      valueDate: 6,
    });
    expect(account(6, "ACC-002")).toMatchObject({ closingLedgerMinor: 10008n });
  });

  it("given the whole replay, when counting ledger entries, then there are 3 fees, 2 interest and 14 in total", () => {
    const engine = new LedgerEngine(SCENARIO_CONFIG, noopLogger);
    for (const event of SCENARIO_EVENTS) {
      engine.advanceTo(event.day);
      engine.process(event);
    }
    engine.closeWindow();
    const entries = engine.entries();
    expect(entries.filter((e) => e.kind === "FEE")).toHaveLength(3);
    expect(entries.filter((e) => e.kind === "INTEREST")).toHaveLength(2);
    expect(entries).toHaveLength(14);
  });

  it("given the same inputs, when replayed twice, then the reports are identical", () => {
    const again = replay(SCENARIO_CONFIG, SCENARIO_EVENTS, noopLogger);
    expect(formatReplay(again)).toBe(formatReplay(result));
  });

  it("given the replay, when formatted, then each day, the authorizations and the restated table are present", () => {
    const text = formatReplay(result);
    for (let n = 1; n <= 6; n++) {
      expect(text).toContain(`=== Day ${n} (end of day, as known) ===`);
    }
    expect(text).toContain("=== Restated by value date (final) ===");
    expect(text).toContain("DECLINED");
    expect(text).toContain("UNKNOWN_AUTHORIZATION");
    expect(text).toContain("390.93 AED");
    expect(text).toContain("10.008 BHD");
    expect(text).toContain("check: OK");
  });

  it("given the logger, when the replay runs, then every line is valid JSON with correlation ids", () => {
    const lines: string[] = [];
    const logger = createJsonLogger(
      (line) => lines.push(line),
      () => "T",
    );
    replay(SCENARIO_CONFIG, SCENARIO_EVENTS, logger);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const rejected = parsed.filter((p) => p["event"] === "event.rejected");
    expect(rejected.map((p) => p["eventId"])).toEqual(["E6"]);
    expect(parsed.filter((p) => p["event"] === "fee.assessed")).toHaveLength(3);
    expect(parsed.filter((p) => p["event"] === "day.closed")).toHaveLength(6);
  });
});

describe("CLI", () => {
  it("given the real entry point, when run, then it exits 0, prints the report to stdout and JSON logs to stderr", () => {
    const run = spawnSync("node", ["--import", "tsx", "src/replay.ts"], {
      encoding: "utf8",
      timeout: 60_000,
    });

    expect(run.status).toBe(0);
    for (const expected of [
      "=== Day 1 (end of day, as known) ===",
      "=== Day 6 (end of day, as known) ===",
      "=== Restated by value date (final) ===",
      "Auth-B",
      "DECLINED",
      "UNKNOWN_AUTHORIZATION",
      "390.93 AED",
      "10.008 BHD",
    ]) {
      expect(run.stdout).toContain(expected);
    }
    const logLines = run.stderr.split("\n").filter((line) => line.trim() !== "");
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 60_000);
});
