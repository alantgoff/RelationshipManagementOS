import { ROLE_LABELS, type Role } from "@/domain/enums";

export function RoleChips({ roles, tags = [] }: { roles: Role[]; tags?: string[] }) {
  if (roles.length === 0 && tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <span key={r} className="rounded border border-border px-1.5 py-0.5 text-xs text-muted">
          {ROLE_LABELS[r]}
        </span>
      ))}
      {tags.map((t) => (
        <span key={t} className="rounded bg-background px-1.5 py-0.5 text-xs text-muted">
          #{t}
        </span>
      ))}
    </span>
  );
}
