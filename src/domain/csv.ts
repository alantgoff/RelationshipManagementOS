import type { Role } from "./enums";
import { ROLES } from "./enums";

/** Person fields a CSV column can map to. */
export const CSV_TARGETS = [
  "fullName",
  "preferredName",
  "email",
  "phone",
  "company",
  "title",
  "location",
  "howWeMet",
  "notes",
  "roles",
  "tags",
  "cadenceDays",
] as const;
export type CsvTarget = (typeof CSV_TARGETS)[number];

export const CSV_TARGET_LABELS: Record<CsvTarget, string> = {
  fullName: "Full name",
  preferredName: "Preferred name",
  email: "Email",
  phone: "Phone",
  company: "Company",
  title: "Title",
  location: "Location",
  howWeMet: "How we met",
  notes: "Notes",
  roles: "Roles",
  tags: "Tags",
  cadenceDays: "Cadence (days)",
};

/** header -> target, or null to skip the column */
export type ColumnMapping = Record<string, CsvTarget | null>;

export interface ImportedPerson {
  fullName: string;
  preferredName?: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  location?: string;
  howWeMet?: string;
  notes?: string;
  roles: Role[];
  tags: string[];
  cadenceDays?: number;
}

export interface RowIssue {
  row: number;
  message: string;
}

const HEADER_ALIASES: Record<string, CsvTarget> = {
  name: "fullName",
  fullname: "fullName",
  "full name": "fullName",
  "first name": "fullName",
  preferred: "preferredName",
  nickname: "preferredName",
  email: "email",
  "e-mail": "email",
  phone: "phone",
  mobile: "phone",
  company: "company",
  organisation: "company",
  organization: "company",
  firm: "company",
  title: "title",
  role: "roles",
  roles: "roles",
  tags: "tags",
  location: "location",
  city: "location",
  notes: "notes",
  "how we met": "howWeMet",
  cadence: "cadenceDays",
  "cadence days": "cadenceDays",
};

/** Best-effort automatic column mapping from header names. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<CsvTarget>();
  for (const h of headers) {
    const key = h.trim().toLowerCase();
    const target = HEADER_ALIASES[key] ?? (CSV_TARGETS as readonly string[]).find((t) => t.toLowerCase() === key);
    if (target && !used.has(target as CsvTarget)) {
      mapping[h] = target as CsvTarget;
      used.add(target as CsvTarget);
    } else {
      mapping[h] = null;
    }
  }
  return mapping;
}

function splitList(value: string): string[] {
  return value
    .split(/[;,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeRole(raw: string): Role | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, Role> = {
    lp: "prospective_lp",
    prospective_lp: "prospective_lp",
    committed_lp: "committed_lp",
    coinvestor: "co_investor",
    co_investor: "co_investor",
    deal_source: "deal_source",
    dealsource: "deal_source",
  };
  const candidate = aliases[key] ?? key;
  return (ROLES as readonly string[]).includes(candidate) ? (candidate as Role) : null;
}

/** Apply a column mapping to parsed rows. Rows without a name are reported, not imported. */
export function mapRows(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
): { people: ImportedPerson[]; issues: RowIssue[] } {
  const people: ImportedPerson[] = [];
  const issues: RowIssue[] = [];
  rows.forEach((row, i) => {
    const p: ImportedPerson = { fullName: "", roles: [], tags: [] };
    for (const [header, target] of Object.entries(mapping)) {
      if (!target) continue;
      const raw = (row[header] ?? "").trim();
      if (!raw) continue;
      switch (target) {
        case "roles":
          for (const r of splitList(raw)) {
            const role = normalizeRole(r);
            if (role) p.roles.push(role);
            else issues.push({ row: i + 1, message: `Unknown role "${r}" ignored` });
          }
          break;
        case "tags":
          p.tags.push(...splitList(raw));
          break;
        case "cadenceDays": {
          const n = Number.parseInt(raw, 10);
          if (Number.isFinite(n) && n > 0) p.cadenceDays = n;
          else issues.push({ row: i + 1, message: `Invalid cadence "${raw}" ignored` });
          break;
        }
        case "email":
          p.email = raw.toLowerCase();
          break;
        default:
          p[target] = raw;
      }
    }
    if (!p.fullName) {
      issues.push({ row: i + 1, message: "Missing name; row skipped" });
      return;
    }
    people.push(p);
  });
  return { people, issues };
}

/** Exact email matches against existing people, per FR-4. */
export function findDuplicates<T extends { email?: string | null }>(
  incoming: ImportedPerson[],
  existing: T[],
): Map<number, T> {
  const byEmail = new Map<string, T>();
  for (const e of existing) if (e.email) byEmail.set(e.email.toLowerCase(), e);
  const dupes = new Map<number, T>();
  incoming.forEach((p, i) => {
    if (p.email && byEmail.has(p.email)) dupes.set(i, byEmail.get(p.email)!);
  });
  return dupes;
}
