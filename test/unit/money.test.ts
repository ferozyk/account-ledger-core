import { describe, it, expect } from "vitest";
import {
  CURRENCY_DECIMALS,
  allocate,
  applyRate,
  formatMinor,
  parseMoney,
  roundHalfEven,
} from "../../src/money.js";

describe("parseMoney", () => {
  it.each([
    ["AED", "1200.00", 120000n],
    ["AED", "1200", 120000n],
    ["AED", "0.5", 50n],
    ["AED", "0", 0n],
    ["AED", "0.00", 0n],
    ["BHD", "10.000", 10000n],
    ["BHD", "3.334", 3334n],
    ["BHD", "0.001", 1n],
  ] as const)("given %s %s, when parsed, then minor units are %s", (currency, text, minor) => {
    expect(parseMoney(currency, text)).toEqual({ ok: true, value: { currency, minor } });
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["positive sign", "+5.00"],
    ["negative sign", "-5.00"],
    ["thousands separator", "1,200.00"],
    ["letters", "12a.00"],
    ["exponent", "1e3"],
    ["missing whole part", ".5"],
    ["trailing point", "5."],
    ["surrounding space", " 5.00"],
    ["double point", "1.2.3"],
  ])("given %s input, when parsed, then it is rejected as INVALID_AMOUNT", (_name, text) => {
    const result = parseMoney("AED", text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_AMOUNT");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it("given more fractional digits than the currency allows, when parsed, then it is rejected, not rounded", () => {
    expect(parseMoney("AED", "1.005").ok).toBe(false);
    expect(parseMoney("BHD", "3.3333").ok).toBe(false);
  });

  it("given exactly the currency precision, when parsed, then it is accepted", () => {
    expect(parseMoney("AED", "1.05").ok).toBe(true);
    expect(parseMoney("BHD", "1.005").ok).toBe(true);
  });

  it("given a value beyond Number precision, when parsed, then no precision is lost", () => {
    expect(parseMoney("AED", "90071992547409930.01")).toEqual({
      ok: true,
      value: { currency: "AED", minor: 9007199254740993001n },
    });
  });
});

describe("formatMinor", () => {
  it.each([
    ["AED", -37000n, "-370.00"],
    ["BHD", 3334n, "3.334"],
    ["AED", 5n, "0.05"],
    ["AED", -5n, "-0.05"],
    ["AED", 0n, "0.00"],
    ["BHD", 0n, "0.000"],
    ["BHD", -1n, "-0.001"],
    ["AED", 100n, "1.00"],
  ] as const)("given %s %s minor, when formatted, then %s", (currency, minor, expected) => {
    expect(formatMinor(currency, minor)).toBe(expected);
  });

  it("given a parsed amount, when formatted, then it round-trips", () => {
    const parsed = parseMoney("BHD", "12.340");
    expect(parsed.ok && formatMinor("BHD", parsed.value.minor)).toBe("12.340");
  });
});

describe("roundHalfEven", () => {
  it.each([
    [10n, 4n, 2n], // 2.5 -> even 2
    [14n, 4n, 4n], // 3.5 -> even 4
    [-10n, 4n, -2n], // -2.5 -> even -2
    [-14n, 4n, -4n], // -3.5 -> even -4
    [1n, 2n, 0n], // 0.5 -> 0
    [-1n, 2n, 0n], // -0.5 -> 0
    [3n, 2n, 2n], // 1.5 -> 2
    [-3n, 2n, -2n], // -1.5 -> -2
  ])("given a tie %s/%s, when rounded, then it goes to the even neighbour %s", (n, d, expected) => {
    expect(roundHalfEven(n, d)).toBe(expected);
  });

  it.each([
    [7n, 3n, 2n], // 2.33
    [8n, 3n, 3n], // 2.67
    [-7n, 3n, -2n],
    [-8n, 3n, -3n],
    [0n, 5n, 0n],
    [6n, 3n, 2n], // exact
    [-6n, 3n, -2n],
  ])("given a non-tie %s/%s, when rounded, then it goes to nearest %s", (n, d, expected) => {
    expect(roundHalfEven(n, d)).toBe(expected);
  });

  it.each([0n, -1n])("given denominator %s, when rounded, then it throws RangeError", (d) => {
    expect(() => roundHalfEven(1n, d)).toThrow(RangeError);
  });
});

describe("applyRate", () => {
  it("given 5% on 370.00 AED, when applied, then the result is exact", () => {
    expect(applyRate(37000n, { numerator: 5n, denominator: 100n })).toBe(1850n);
  });

  it("given a tie result, when applied, then it rounds half to even", () => {
    const tenth = { numerator: 1n, denominator: 10n };
    expect(applyRate(25n, tenth)).toBe(2n); // 2.5
    expect(applyRate(35n, tenth)).toBe(4n); // 3.5
    expect(applyRate(-25n, tenth)).toBe(-2n);
  });

  it("given a zero amount, when applied, then the result is zero", () => {
    expect(applyRate(0n, { numerator: 7n, denominator: 3n })).toBe(0n);
  });
});

describe("allocate", () => {
  it("given 10000 into 3 parts, when allocated, then the remainder goes to the earliest part", () => {
    expect(allocate(10000n, 3)).toEqual([3334n, 3333n, 3333n]);
  });

  it("given a remainder of several units, when allocated, then the earliest parts each get one", () => {
    expect(allocate(5n, 3)).toEqual([2n, 2n, 1n]);
  });

  it("given a single part, when allocated, then it receives the whole total", () => {
    expect(allocate(123n, 1)).toEqual([123n]);
  });

  it("given a total smaller than parts, when allocated, then some parts are zero", () => {
    expect(allocate(2n, 4)).toEqual([1n, 1n, 0n, 0n]);
  });

  it("given a zero total, when allocated, then every part is zero", () => {
    expect(allocate(0n, 3)).toEqual([0n, 0n, 0n]);
  });

  it("given many totals and part counts, when allocated, then parts sum exactly and differ by at most 1", () => {
    for (let total = 0n; total <= 200n; total++) {
      for (let parts = 1; parts <= 13; parts++) {
        const result = allocate(total, parts);
        expect(result).toHaveLength(parts);
        expect(result.reduce((a, b) => a + b, 0n)).toBe(total);
        expect(
          Math.max(...result.map(Number)) - Math.min(...result.map(Number)),
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "given parts %s, when allocated, then it throws RangeError",
    (parts) => {
      expect(() => allocate(100n, parts)).toThrow(RangeError);
    },
  );

  it("given a negative total, when allocated, then it throws RangeError", () => {
    expect(() => allocate(-1n, 2)).toThrow(RangeError);
  });
});

describe("CURRENCY_DECIMALS", () => {
  it("declares the precision of each supported currency", () => {
    expect(CURRENCY_DECIMALS).toEqual({ AED: 2, BHD: 3 });
  });
});
