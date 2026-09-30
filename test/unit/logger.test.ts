import { describe, expect, it } from "vitest";
import { createJsonLogger, createRecordingLogger, noopLogger } from "../../src/logger.js";

describe("createJsonLogger", () => {
  it("given fields with a bigint, when logged, then one JSON line with ts, level, event and stringified bigint", () => {
    const lines: string[] = [];
    const logger = createJsonLogger(
      (line) => lines.push(line),
      () => "T0",
    );

    logger.info("fee.assessed", { eventId: "E1", amountMinor: 2500n, skipped: undefined });
    logger.error("boom");

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { ts: "T0", level: "info", event: "fee.assessed", eventId: "E1", amountMinor: "2500" },
      { ts: "T0", level: "error", event: "boom" },
    ]);
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
  });
});

describe("createRecordingLogger", () => {
  it("given calls at each level, when recorded, then they are kept in order", () => {
    const { logger, records } = createRecordingLogger();
    logger.info("a", { x: 1 });
    logger.warn("b");
    logger.error("c");
    expect(records.map((r) => [r.level, r.event])).toEqual([
      ["info", "a"],
      ["warn", "b"],
      ["error", "c"],
    ]);
  });

  it("given the noop logger, when used, then it does nothing", () => {
    expect(() => noopLogger.warn("x", { a: 1n })).not.toThrow();
  });
});
