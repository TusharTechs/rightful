/**
 * Amounts are integer minor units (cents) everywhere in Firsthand. Code converts them to PayPal's
 * decimal strings at the edge; no model ever computes or formats a price.
 */

export type Money = { currency_code: string; value: string };

/** Currencies PayPal sends without decimals. */
const ZERO_DECIMAL = new Set(["HUF", "JPY", "TWD"]);

export function toMoney(minorUnits: number, currency = "USD"): Money {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new RangeError(`amount must be a non-negative integer number of minor units, got ${minorUnits}`);
  }
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return { currency_code: code, value: String(minorUnits) };
  const whole = Math.floor(minorUnits / 100);
  const cents = String(minorUnits % 100).padStart(2, "0");
  return { currency_code: code, value: `${whole}.${cents}` };
}

export function fromMoney(money: Money): number {
  const code = money.currency_code.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return Number.parseInt(money.value, 10);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(money.value);
  if (!match) throw new RangeError(`not a PayPal amount: ${money.value}`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
