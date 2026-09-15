const DAY = 86_400_000;

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function daysAgo(d: Date | null | undefined, now = new Date()): string {
  if (!d) return "never";
  const days = Math.floor((now.getTime() - d.getTime()) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function relativeDue(d: Date | null | undefined, now = new Date()): string {
  if (!d) return "no date";
  const days = Math.ceil((d.getTime() - now.getTime()) / DAY);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

/** yyyy-mm-dd for <input type="date"> */
export function toDateInput(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
