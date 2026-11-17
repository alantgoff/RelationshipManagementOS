/**
 * Timezone helpers built on Intl, so the server (UTC on Vercel) can reason in
 * the owner's local time: "Friday", "7:30 brief", quiet hours.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Fall back to UTC for unknown zones instead of throwing deep in a cron job. */
export function safeTimeZone(tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdayShort,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date, YYYY-MM-DD. */
export function localDate(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function weekdayName(date: Date, tz: string): string {
  return WEEKDAYS[zonedParts(date, tz).weekday];
}

/** Minutes since local midnight. */
export function localMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

/** "07:30" → 450. Returns null for malformed input. */
export function parseHM(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Whether `minutes` falls in [start, end), where the window may wrap past midnight. */
export function inWindow(minutes: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * The UTC instant for a local wall-clock time on a local date, e.g. noon on
 * 2026-10-02 in America/New_York. Handles DST by re-checking the offset.
 */
export function zonedTimeToUtc(dateStr: string, hour: number, minute: number, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`Invalid date ${dateStr}; use YYYY-MM-DD`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute);
  const offsetAt = (t: number) => {
    const p = zonedParts(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - t;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(dateStr: string, days: number): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
