import type { ISODate } from './contracts';

const DAY_MS = 86_400_000;
const BANGKOK_OFFSET_MS = 7 * 3_600_000;

/** Strict Gregorian date check, shared by form schemas and clinic calculations. */
export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function midnightUTC(date: ISODate): number {
  if (!isISODate(date)) throw new RangeError('A real YYYY-MM-DD clinic date is required');
  return new Date(`${date}T00:00:00.000Z`).getTime();
}

export function bangkokDate(now: Date): ISODate {
  if (!Number.isFinite(now.getTime())) throw new RangeError('A valid clock is required');
  return new Date(now.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

export function bookingRange(now: Date): { min: ISODate; max: ISODate } {
  const today = midnightUTC(bangkokDate(now));
  return {
    min: new Date(today + DAY_MS).toISOString().slice(0, 10),
    max: new Date(today + 90 * DAY_MS).toISOString().slice(0, 10),
  };
}

export function cancelBefore(date: ISODate): string {
  return new Date(midnightUTC(date) - BANGKOK_OFFSET_MS).toISOString();
}

export function reminderAt(date: ISODate): string {
  return new Date(midnightUTC(date) - DAY_MS + 18 * 3_600_000 - BANGKOK_OFFSET_MS).toISOString();
}
