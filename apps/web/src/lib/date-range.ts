export const INVENTORY_TIME_ZONE = 'America/Santiago';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: INVENTORY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});

export function inventoryDate(value = new Date()): string {
  const parts = dayFormatter.formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function currentMonthStart(now = new Date()): string {
  return inventoryDate(now).slice(0, 7) + '-01';
}

const localTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: INVENTORY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function localTimeParts(value: number): number[] {
  const parts = localTimeFormatter.formatToParts(new Date(value));
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((type) => Number(parts.find((part) => part.type === type)!.value));
}

/** Round-trip wall-clock input; reject skipped or repeated Chilean DST times. */
export function inventoryDateTimeToUtc(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new RangeError('Invalid local date/time');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  if (hour > 23 || minute > 59 || new Date(wallClock).toISOString().slice(0, 10) !== date) throw new RangeError('Invalid local date/time');
  const offsets = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const sample = wallClock + delta;
    const [y, m, d, h, min, s] = localTimeParts(sample);
    offsets.add(Date.UTC(y, m - 1, d, h, min, s) - sample);
  }
  const expected = [year, month, day, hour, minute, 0];
  const matches = [...offsets].map((offset) => wallClock - offset)
    .filter((candidate) => localTimeParts(candidate).every((part, index) => part === expected[index]));
  if (matches.length !== 1) throw new RangeError(matches.length ? 'Ambiguous local time' : 'Nonexistent local time');
  return new Date(matches[0]).toISOString();
}

export function formatInventoryDateTime(value: string): string {
  return new Intl.DateTimeFormat('es-CL', { timeZone: INVENTORY_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function previousMonthDates(now = new Date()): { from: string; to: string } {
  const to = shiftDate(currentMonthStart(now), -1);
  return { from: to.slice(0, 7) + '-01', to };
}

function startOfInventoryDay(value: string): number {
  const midnight = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(midnight)) throw new RangeError('Invalid date');
  let lower = midnight - 18 * 3600000;
  let upper = midnight + 18 * 3600000;
  // Chile's daylight-saving transition can skip midnight; find the actual day boundary.
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (inventoryDate(new Date(middle)) < value) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

export function inventoryDateRange(from?: string, to?: string): { from?: string; to?: string } {
  return {
    from: from ? new Date(startOfInventoryDay(from)).toISOString() : undefined,
    to: to ? new Date(startOfInventoryDay(shiftDate(to, 1)) - 1).toISOString() : undefined
  };
}
