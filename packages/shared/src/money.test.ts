import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, fromCents, addMoney, sumMoney, sumBy, roundMoney, moneyEquals, centsApart } from './money.ts';

describe('money arithmetic', () => {
  // The specific failures that motivated this module.
  test('the classic float errors do not survive', () => {
    assert.equal(addMoney(0.1, 0.2), 0.3);
    assert.notEqual(0.1 + 0.2, 0.3);
  });

  test('summing realistic line prices is exact', () => {
    const prices = [604.5, 254, 168, 1711, 33.6, 108, 16, 60];
    const fees = [150, 150, 275, 99.99, 10.1, 0.1, 0.2, 0.3];

    // The naive version drifts.
    const naive = prices.reduce((a, p, i) => a + p + fees[i], 0);
    assert.notEqual(naive, 3640.79);

    assert.equal(sumMoney([...prices, ...fees]), 3640.79);
  });

  test('repeated addition does not accumulate error', () => {
    let total = 0;
    for (let i = 0; i < 1000; i++) total = addMoney(total, 0.07);
    assert.equal(total, 70);
  });

  test('a carrier premium plus a broker fee is exact', () => {
    assert.equal(addMoney(604.5, 150), 754.5);
    assert.equal(addMoney(604.5, 150.3), 754.8);
    assert.equal(addMoney(1711, 99.99), 1810.99);
  });
});

describe('cents conversion', () => {
  test('round-trips', () => {
    for (const v of [0, 0.01, 1, 604.5, 1234.56, 99999.99]) {
      assert.equal(fromCents(toCents(v)), v);
    }
  });

  test('rounds rather than truncating', () => {
    // A value that arrived as 604.4999999 must not lose a cent.
    assert.equal(toCents(604.4999999), 60450);
    assert.equal(toCents(0.005), 1);
  });

  test('absent amounts are zero, never NaN', () => {
    assert.equal(toCents(null), 0);
    assert.equal(toCents(undefined), 0);
    assert.equal(toCents(NaN), 0);
    assert.equal(toCents(Infinity), 0);
  });
});

describe('null handling', () => {
  // A line with no premium yet must contribute nothing, not poison the total.
  test('nulls in a sum contribute zero', () => {
    assert.equal(sumMoney([100, null, 50, undefined]), 150);
  });

  test('a total of nothing is zero', () => {
    assert.equal(sumMoney([]), 0);
    assert.equal(sumMoney([null, undefined]), 0);
  });

  test('sumBy handles a list of records', () => {
    const lines = [{ price: 604.5 }, { price: 254 }, { price: null }];
    assert.equal(sumBy(lines, (l) => l.price), 858.5);
  });
});

describe('comparison', () => {
  // Direct float equality is the bug this module prevents, and the premium
  // reconciliation check is exactly where it would appear.
  test('amounts equal at cent precision compare equal', () => {
    assert.equal(moneyEquals(0.1 + 0.2, 0.3), true);
    assert.equal(0.1 + 0.2 === 0.3, false);
  });

  test('a genuine one-cent difference is still detected', () => {
    assert.equal(moneyEquals(604.5, 604.51), false);
    assert.equal(centsApart(604.5, 604.51), 1);
  });

  test('components summing to their total reconcile', () => {
    const components = [1291, 5654, 252, 426, 9, 70.68];
    assert.equal(sumMoney(components), 7702.68);
    assert.equal(centsApart(sumMoney(components), 7702.68), 0);
  });

  // A discount is negative; the sum must still land exactly.
  test('negative components are handled', () => {
    assert.equal(sumMoney([1885, 8447, 406, 5, -2695, 49, 24]), 8121);
  });
});

describe('roundMoney', () => {
  test('snaps a stray value to cents', () => {
    assert.equal(roundMoney(3640.7899999999995), 3640.79);
    assert.equal(roundMoney(0.30000000000000004), 0.3);
  });

  test('absent is zero', () => {
    assert.equal(roundMoney(null), 0);
    assert.equal(roundMoney(undefined), 0);
  });
});
