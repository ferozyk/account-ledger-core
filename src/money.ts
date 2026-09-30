import type { Currency, Money, Rejection, Result } from "./types.js";

export const CURRENCY_DECIMALS: Readonly<Record<Currency, number>> = { AED: 2, BHD: 3 };

export interface Rate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function invalid(message: string): Result<Money, Rejection> {
  return { ok: false, error: { code: "INVALID_AMOUNT", message } };
}

/** Strict parse of a non-negative plain decimal; never rounds excess precision. */
export function parseMoney(currency: Currency, decimal: string): Result<Money, Rejection> {
  const match = PLAIN_DECIMAL.exec(decimal);
  if (match === null) {
    return invalid(`"${decimal}" is not a plain non-negative decimal amount`);
  }
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  const precision = CURRENCY_DECIMALS[currency];
  if (fraction.length > precision) {
    return invalid(
      `"${decimal}" has more than ${precision} decimal places allowed for ${currency}`,
    );
  }
  return { ok: true, value: { currency, minor: BigInt(whole + fraction.padEnd(precision, "0")) } };
}

export function formatMinor(currency: Currency, minor: bigint): string {
  const precision = CURRENCY_DECIMALS[currency];
  const sign = minor < 0n ? "-" : "";
  const digits = (minor < 0n ? -minor : minor).toString().padStart(precision + 1, "0");
  const split = digits.length - precision;
  return `${sign}${digits.slice(0, split)}.${digits.slice(split)}`;
}

/** Exact rational rounding to the nearest integer, ties to even. */
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError("denominator must be positive");
  }
  let quotient = numerator / denominator;
  let remainder = numerator % denominator;
  // BigInt division truncates toward zero; normalise to floor so the remainder is >= 0.
  if (remainder < 0n) {
    quotient -= 1n;
    remainder += denominator;
  }
  const twice = remainder * 2n;
  const roundUp = twice > denominator || (twice === denominator && quotient % 2n !== 0n);
  return roundUp ? quotient + 1n : quotient;
}

export function applyRate(amountMinor: bigint, rate: Rate): bigint {
  return roundHalfEven(amountMinor * rate.numerator, rate.denominator);
}

/** Splits total into `parts` amounts differing by at most 1; earliest parts take the remainder. */
export function allocate(totalMinor: bigint, parts: number): bigint[] {
  if (!Number.isSafeInteger(parts) || parts <= 0) {
    throw new RangeError("parts must be a positive safe integer");
  }
  if (totalMinor < 0n) {
    throw new RangeError("total must be non-negative");
  }
  const count = BigInt(parts);
  const base = totalMinor / count;
  const remainder = Number(totalMinor % count);
  return Array.from({ length: parts }, (_, index) => (index < remainder ? base + 1n : base));
}
