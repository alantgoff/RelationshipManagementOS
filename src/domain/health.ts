import type { Health, Role } from "./enums";

/** Default desired days between touches, per spec 0001 section 4. */
export const DEFAULT_CADENCE_DAYS: Partial<Record<Role, number>> = {
  prospective_lp: 21,
  committed_lp: 45,
  deal_source: 30,
  founder: 45,
  co_investor: 60,
  mentor: 60,
  friend: 45,
  family: 30,
};

const MS_PER_DAY = 86_400_000;

/**
 * Resolve the default cadence for a set of roles. The shortest default wins.
 * Returns null when no role carries a default (e.g. only `other`).
 */
export function defaultCadenceForRoles(
  roles: readonly Role[],
  overrides: Partial<Record<Role, number>> = {},
): number | null {
  let best: number | null = null;
  for (const role of roles) {
    const days = overrides[role] ?? DEFAULT_CADENCE_DAYS[role];
    if (days == null) continue;
    if (best === null || days < best) best = days;
  }
  return best;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

export interface HealthInput {
  cadenceDays: number | null;
  lastInteractionAt: Date | null;
  now?: Date;
}

/** Health rules from spec 0001 section 4. Pure; no I/O. */
export function computeHealth({ cadenceDays, lastInteractionAt, now = new Date() }: HealthInput): Health {
  if (cadenceDays == null || cadenceDays <= 0) return "no_cadence";
  if (lastInteractionAt == null) return "never";
  const days = daysBetween(lastInteractionAt, now);
  if (days <= 0.5 * cadenceDays) return "fresh";
  if (days <= cadenceDays) return "warm";
  if (days <= 1.5 * cadenceDays) return "due";
  return "cold";
}

/** Dashboard ordering: cold, then due, then never. Others are not shown. */
export const DASHBOARD_HEALTH_ORDER: Health[] = ["cold", "due", "never"];

export function isDashboardHealth(h: Health): boolean {
  return DASHBOARD_HEALTH_ORDER.includes(h);
}

export interface DashboardSortable {
  health: Health;
  cadenceDays: number | null;
  fullName: string;
}

/** Sort per FR-11: health rank, then shortest cadence, then name. */
export function compareForDashboard(a: DashboardSortable, b: DashboardSortable): number {
  const ra = DASHBOARD_HEALTH_ORDER.indexOf(a.health);
  const rb = DASHBOARD_HEALTH_ORDER.indexOf(b.health);
  if (ra !== rb) return ra - rb;
  const ca = a.cadenceDays ?? Number.MAX_SAFE_INTEGER;
  const cb = b.cadenceDays ?? Number.MAX_SAFE_INTEGER;
  if (ca !== cb) return ca - cb;
  return a.fullName.localeCompare(b.fullName);
}
