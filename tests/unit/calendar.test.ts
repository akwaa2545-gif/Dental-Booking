import { describe, expect, it } from 'vitest';
import { bangkokDate, bookingRange, cancelBefore, reminderAt } from '../../src/shared/calendar';

describe('Bangkok clinic dates', () => {
  it('bangkok_range_is_inclusive', () => {
    expect(bookingRange(new Date('2026-10-07T12:00:00Z'))).toEqual({ min: '2026-10-08', max: '2027-01-05' });
  });
  it('uses Bangkok midnight rather than UTC or device-local midnight', () => {
    expect(bangkokDate(new Date('2026-10-07T16:59:59Z'))).toBe('2026-10-07');
    expect(bangkokDate(new Date('2026-10-07T17:00:00Z'))).toBe('2026-10-08');
  });
  it('derives the strict cancellation cutoff at appointment-day midnight', () => {
    expect(cancelBefore('2026-10-09')).toBe('2026-10-08T17:00:00.000Z');
  });
  it('derives one reminder at 18:00 Bangkok on the previous day', () => {
    expect(reminderAt('2026-10-09')).toBe('2026-10-08T11:00:00.000Z');
  });
  it('handles leap days and year boundaries without local timezone arithmetic', () => {
    expect(bookingRange(new Date('2028-02-28T12:00:00Z'))).toEqual({ min: '2028-02-29', max: '2028-05-28' });
    expect(cancelBefore('2027-01-01')).toBe('2026-12-31T17:00:00.000Z');
  });
  it.each(['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-09', 'invalid'])('rejects impossible or malformed date %s', (date) => {
    expect(() => cancelBefore(date)).toThrow();
    expect(() => reminderAt(date)).toThrow();
  });
  it('rejects invalid clocks rather than returning invalid calendar strings', () => {
    expect(() => bangkokDate(new Date('invalid'))).toThrow();
    expect(() => bookingRange(new Date('invalid'))).toThrow();
  });
});
