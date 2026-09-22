import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isoDate } from './detail.ts';

/*
 * A `date` column is a calendar day, not an instant.
 *
 * Drivers that hand one back as a JS Date build it at LOCAL midnight. Reading
 * the UTC calendar day off that — .toISOString().slice(0, 10) — returns the
 * PREVIOUS day on every machine ahead of UTC, which is most of the world east of
 * Greenwich and, in practice, the host this was found on.
 *
 * The bug was live: an effective date stored as 2026-08-12 reached the review
 * screen as 2026-08-11. These run under a fixed UTC+8 so the failure is
 * reproducible from any machine rather than only from one in the wrong zone.
 */
describe('calendar dates survive a timezone ahead of UTC', () => {
  const withTz = (tz: string, fn: () => void) => {
    const previous = process.env.TZ;
    process.env.TZ = tz;
    try {
      fn();
    } finally {
      process.env.TZ = previous;
    }
  };

  test('a Date at local midnight keeps its own calendar day', () => {
    withTz('Asia/Manila', () => {
      // Exactly what a driver produces for the column value 2026-08-12.
      const asDriverBuildsIt = new Date(2026, 7, 12, 0, 0, 0);
      assert.equal(isoDate(asDriverBuildsIt), '2026-08-12');
    });
  });

  test('the turn of the year does not slip back to the old one', () => {
    withTz('Pacific/Kiritimati', () => {
      assert.equal(isoDate(new Date(2027, 0, 1, 0, 0, 0)), '2027-01-01');
    });
  });

  test('a plain string is passed through untouched', () => {
    assert.equal(isoDate('2026-08-12'), '2026-08-12');
    assert.equal(isoDate(null), null);
  });
});
