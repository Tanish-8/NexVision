import { describe, expect, it } from 'vitest';
import { isRelativeDateExpression, resolveRelativeDate } from './temporal.js';

describe('Deterministic Temporal Grounding (resolveRelativeDate)', () => {
  const FIXED_REF = '2026-09-29';

  describe('Core relative date resolution against deterministic reference (2026-09-29)', () => {
    it('resolves "today" to reference date', () => {
      expect(resolveRelativeDate('today', FIXED_REF)).toBe('2026-09-29');
      expect(resolveRelativeDate('Today', FIXED_REF)).toBe('2026-09-29');
      expect(resolveRelativeDate('  today  ', FIXED_REF)).toBe('2026-09-29');
    });

    it('resolves "today\'s date" variants to reference date', () => {
      // Standard ASCII apostrophe
      expect(resolveRelativeDate("today's date", FIXED_REF)).toBe('2026-09-29');
      // No apostrophe
      expect(resolveRelativeDate('todays date', FIXED_REF)).toBe('2026-09-29');
      // Typographical curly apostrophe (U+2019)
      expect(resolveRelativeDate('today’s date', FIXED_REF)).toBe('2026-09-29');
      // Mixed case
      expect(resolveRelativeDate("Today's Date", FIXED_REF)).toBe('2026-09-29');
    });

    it('resolves "tomorrow" to reference date + 1 day', () => {
      expect(resolveRelativeDate('tomorrow', FIXED_REF)).toBe('2026-09-30');
      expect(resolveRelativeDate('Tomorrow', FIXED_REF)).toBe('2026-09-30');
      expect(resolveRelativeDate("tomorrow's date", FIXED_REF)).toBe('2026-09-30');
      expect(resolveRelativeDate('tomorrows date', FIXED_REF)).toBe('2026-09-30');
    });

    it('resolves "yesterday" to reference date - 1 day', () => {
      expect(resolveRelativeDate('yesterday', FIXED_REF)).toBe('2026-09-28');
      expect(resolveRelativeDate('Yesterday', FIXED_REF)).toBe('2026-09-28');
      expect(resolveRelativeDate("yesterday's date", FIXED_REF)).toBe('2026-09-28');
      expect(resolveRelativeDate('yesterdays date', FIXED_REF)).toBe('2026-09-28');
    });
  });

  describe('Boundary transitions', () => {
    it('handles month boundary transitions correctly (September -> October)', () => {
      expect(resolveRelativeDate('tomorrow', '2026-09-30')).toBe('2026-10-01');
      expect(resolveRelativeDate('yesterday', '2026-10-01')).toBe('2026-09-30');
    });

    it('handles year boundary forward transition: 2026-12-31 + tomorrow -> 2027-01-01', () => {
      expect(resolveRelativeDate('tomorrow', '2026-12-31')).toBe('2027-01-01');
    });

    it('handles year boundary backward transition: 2027-01-01 + yesterday -> 2026-12-31', () => {
      expect(resolveRelativeDate('yesterday', '2027-01-01')).toBe('2026-12-31');
    });

    it('handles leap year transitions correctly', () => {
      // 2024 is a leap year
      expect(resolveRelativeDate('tomorrow', '2024-02-28')).toBe('2024-02-29');
      expect(resolveRelativeDate('tomorrow', '2024-02-29')).toBe('2024-03-01');
      expect(resolveRelativeDate('yesterday', '2024-03-01')).toBe('2024-02-29');

      // 2025 is not a leap year
      expect(resolveRelativeDate('tomorrow', '2025-02-28')).toBe('2025-03-01');
      expect(resolveRelativeDate('yesterday', '2025-03-01')).toBe('2025-02-28');
    });
  });

  describe('Preservation of canonical ISO dates', () => {
    it('preserves already-canonical YYYY-MM-DD input without modification', () => {
      expect(resolveRelativeDate('2026-09-29', FIXED_REF)).toBe('2026-09-29');
      expect(resolveRelativeDate('2023-10-01', FIXED_REF)).toBe('2023-10-01');
      expect(resolveRelativeDate('2025-01-15', '2026-09-29')).toBe('2025-01-15');
    });
  });

  describe('Non-date and unsupported expression safety', () => {
    it('leaves unrelated strings untouched', () => {
      expect(resolveRelativeDate('college', FIXED_REF)).toBe('college');
      expect(resolveRelativeDate('pending', FIXED_REF)).toBe('pending');
      expect(resolveRelativeDate('medium', FIXED_REF)).toBe('medium');
      expect(resolveRelativeDate('submit', FIXED_REF)).toBe('submit');
      expect(resolveRelativeDate('super_secret_999', FIXED_REF)).toBe('super_secret_999');
      expect(resolveRelativeDate('my project today is cool', FIXED_REF)).toBe('my project today is cool');
    });

    it('leaves unsupported relative expressions unchanged rather than guessing', () => {
      expect(resolveRelativeDate('next week', FIXED_REF)).toBe('next week');
      expect(resolveRelativeDate('next Monday', FIXED_REF)).toBe('next Monday');
      expect(resolveRelativeDate('in 2 days', FIXED_REF)).toBe('in 2 days');
      expect(resolveRelativeDate('last month', FIXED_REF)).toBe('last month');
      expect(resolveRelativeDate('someday', FIXED_REF)).toBe('someday');
    });

    it('gracefully handles empty strings, whitespace, and non-string inputs', () => {
      expect(resolveRelativeDate('', FIXED_REF)).toBe('');
      expect(resolveRelativeDate('   ', FIXED_REF)).toBe('   ');
      expect(resolveRelativeDate(null as unknown as string, FIXED_REF)).toBe(null);
      expect(resolveRelativeDate(undefined as unknown as string, FIXED_REF)).toBe(undefined);
    });

    it('handles Date object reference input', () => {
      const dateObj = new Date(2026, 8, 29); // 2026-09-29
      expect(resolveRelativeDate('today', dateObj)).toBe('2026-09-29');
      expect(resolveRelativeDate('tomorrow', dateObj)).toBe('2026-09-30');
      expect(resolveRelativeDate('yesterday', dateObj)).toBe('2026-09-28');
    });

    it('returns original expression if reference date is invalid', () => {
      expect(resolveRelativeDate('today', 'invalid-date-string')).toBe('today');
    });
  });

  describe('isRelativeDateExpression', () => {
    it('correctly detects supported relative date expressions', () => {
      expect(isRelativeDateExpression('today')).toBe(true);
      expect(isRelativeDateExpression("today's date")).toBe(true);
      expect(isRelativeDateExpression('todays date')).toBe(true);
      expect(isRelativeDateExpression('today’s date')).toBe(true);
      expect(isRelativeDateExpression('tomorrow')).toBe(true);
      expect(isRelativeDateExpression("tomorrow's date")).toBe(true);
      expect(isRelativeDateExpression('yesterday')).toBe(true);
      expect(isRelativeDateExpression("yesterday's date")).toBe(true);
    });

    it('returns false for unrelated text, canonical dates, and unsupported expressions', () => {
      expect(isRelativeDateExpression('2026-09-29')).toBe(false);
      expect(isRelativeDateExpression('college')).toBe(false);
      expect(isRelativeDateExpression('next week')).toBe(false);
      expect(isRelativeDateExpression('')).toBe(false);
    });
  });
});
