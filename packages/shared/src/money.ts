/**
 * Money arithmetic.
 *
 * Every figure in this tool is currency, and JavaScript numbers are binary
 * floating point, so 0.1 + 0.2 is 0.30000000000000004 and summing eight
 * realistic line prices gives 3640.7899999999995 instead of 3640.79.
 *
 * Today that rounds back to the right answer at two decimal places, which is
 * exactly why it is worth fixing now: it is invisible until a total lands on a
 * half-cent boundary and a broker is looking at a proposal that is a penny out
 * from the sum of its own rows.
 *
 * The rule: convert to integer cents, do the arithmetic there, convert back once
 * at the end. Postgres already stores these as numeric(12,2) and is exact; the
 * drift is entirely in JavaScript, so this is where it gets fixed.
 */

/** Cents. Integer by construction — never fractional. */
export type Cents = number;

/**
 * Convert a decimal amount to cents.
 *
 * Rounds rather than truncating: `Math.round(604.5 * 100)` is 60450, while
 * `Math.trunc` on a value that arrived as 604.4999999 would silently lose a cent.
 */
export function toCents(amount: number | null | undefined): Cents {
  if (amount == null || !Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

/** Convert cents back to a decimal amount, exact to two places. */
export function fromCents(cents: Cents): number {
  // Dividing an integer by 100 is exact for every value this tool will hold
  // (well inside 2^53), so no rounding is needed on the way out.
  return cents / 100;
}

/**
 * Add money amounts without drift.
 *
 * Null and undefined count as zero, which is what every call site here wants: a
 * line with no premium yet contributes nothing to a total rather than poisoning
 * it with NaN.
 */
export function addMoney(...amounts: Array<number | null | undefined>): number {
  return fromCents(amounts.reduce<Cents>((sum, a) => sum + toCents(a), 0));
}

/** Sum a list. Same guarantees as addMoney. */
export function sumMoney(amounts: Array<number | null | undefined>): number {
  return addMoney(...amounts);
}

/** Sum a projection over a list, which is the shape most call sites need. */
export function sumBy<T>(items: T[], pick: (item: T) => number | null | undefined): number {
  return sumMoney(items.map(pick));
}

/**
 * Round a single amount to cents.
 *
 * For values that arrive from outside — a model's extracted premium, a number
 * typed into a form — before they are stored or compared.
 */
export function roundMoney(amount: number | null | undefined): number {
  if (amount == null || !Number.isFinite(amount)) return 0;
  return fromCents(toCents(amount));
}

/**
 * Compare two amounts at cent precision.
 *
 * Direct equality on floats is the bug this module exists to prevent, and the
 * reconciliation check between a premium and its components is exactly where it
 * would show up.
 */
export function moneyEquals(a: number | null | undefined, b: number | null | undefined): boolean {
  return toCents(a) === toCents(b);
}

/** Difference in cents, for tolerance checks. */
export function centsApart(a: number | null | undefined, b: number | null | undefined): number {
  return Math.abs(toCents(a) - toCents(b));
}
