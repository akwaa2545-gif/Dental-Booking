export const INITIAL_DEMO_TIME = '2026-10-07T03:00:00.000Z';
export function createDemoClock() {
  let current = new Date(INITIAL_DEMO_TIME);
  return {
    now: () => new Date(current),
    set: (value: string) => { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid demo time'); current = date; },
    reset: () => { current = new Date(INITIAL_DEMO_TIME); },
  };
}
export function thaiDate(date: string): string { return new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' }).format(new Date(`${date}T12:00:00+07:00`)); }
export function thaiTime(date: Date): string { return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(date); }
