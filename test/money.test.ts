import assert from "node:assert/strict";
import { test } from "node:test";
import { fromMoney, toMoney } from "../src/paypal/money.ts";

test("cents become PayPal decimal strings and back", () => {
  assert.deepEqual(toMoney(15000), { currency_code: "USD", value: "150.00" });
  assert.deepEqual(toMoney(5, "eur"), { currency_code: "EUR", value: "0.05" });
  assert.deepEqual(toMoney(1200, "JPY"), { currency_code: "JPY", value: "1200" });
  for (const cents of [0, 1, 99, 100, 101, 123456789]) assert.equal(fromMoney(toMoney(cents)), cents);
  assert.equal(fromMoney({ currency_code: "USD", value: "7.5" }), 750);
});

test("fractional or negative amounts are refused before they reach PayPal", () => {
  assert.throws(() => toMoney(10.5), RangeError);
  assert.throws(() => toMoney(-1), RangeError);
  assert.throws(() => fromMoney({ currency_code: "USD", value: "1.234" }), RangeError);
});
