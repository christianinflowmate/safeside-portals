import { describe, test, expect } from 'vitest';
import { formatMoney, parseMoney, formatBytes, lineTypeLabel } from './format.ts';

/**
 * Money parsing is the highest-risk pure function in the frontend: it turns what
 * a broker types into the number that becomes the client's price.
 */
describe('parseMoney', () => {
  test('reads a plain number', () => {
    expect(parseMoney('150')).toBe(150);
    expect(parseMoney('150.50')).toBe(150.5);
  });

  // Brokers type what they see on the quote, which has both of these.
  test('tolerates currency symbols and thousands separators', () => {
    expect(parseMoney('$1,234.56')).toBe(1234.56);
    expect(parseMoney('1,234')).toBe(1234);
    expect(parseMoney(' $604.50 ')).toBe(604.5);
  });

  // An empty field means "no value", which is different from zero: zero is a
  // real premium of nothing, null blocks generation until someone fills it in.
  test('empty input is null, not zero', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('   ')).toBeNull();
  });

  test('nonsense is null rather than NaN', () => {
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('$')).toBeNull();
  });

  test('zero is a real value', () => {
    expect(parseMoney('0')).toBe(0);
  });
});

describe('formatMoney', () => {
  test('formats as US currency', () => {
    expect(formatMoney(1234.5)).toMatch(/\$1,234\.50/);
    expect(formatMoney(0)).toMatch(/\$0\.00/);
  });

  test('renders an em dash for absent values rather than $0.00', () => {
    // Showing $0.00 for "not yet entered" would read as a free policy.
    expect(formatMoney(null)).not.toMatch(/0\.00/);
    expect(formatMoney(undefined)).not.toMatch(/0\.00/);
  });

  test('a parsed value round-trips', () => {
    const parsed = parseMoney('$1,234.56');
    expect(formatMoney(parsed)).toMatch(/\$1,234\.56/);
  });
});

describe('formatBytes', () => {
  test('scales units', () => {
    expect(formatBytes(512)).toMatch(/512/);
    expect(formatBytes(2048)).toMatch(/KB/);
    expect(formatBytes(5 * 1024 * 1024)).toMatch(/MB/);
  });
});

describe('lineTypeLabel', () => {
  test('gives coverage types a readable name', () => {
    expect(lineTypeLabel('business_owners_policy')).not.toContain('_');
    expect(lineTypeLabel('workers_comp')).toMatch(/Workers/i);
    expect(lineTypeLabel('general_liability')).toMatch(/General Liability/i);
  });
});
