import Link from "next/link";
import { HealthBadge } from "@/components/HealthBadge";
import { LogInteractionDialog } from "@/components/LogInteractionDialog";
import { FollowUpCheckbox, ReminderControls } from "@/components/QuickControls";
import { RoleChips } from "@/components/RoleChips";
import { ROLES, ROLE_LABELS, type Role } from "@/domain/enums";
import { daysAgo, relativeDue } from "@/lib/format";
import { getDashboard } from "@/server/queries/dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const { role } = await searchParams;
  const roleFilter = (ROLES as readonly string[]).includes(role ?? "") ? (role as Role) : undefined;
  const d = await getDashboard(roleFilter);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">This week</h1>
          <p className="text-sm text-muted">
            {d.attention.length} of {d.totals.withCadence} people with a cadence need attention.
          </p>
        </div>
        <Link href="/people/new" className="btn btn-primary">+ New person</Link>
      </header>

      <nav className="flex flex-wrap gap-1" aria-label="Filter by role">
        <Link href="/" className={`btn py-1 min-h-8 ${!roleFilter ? "btn-primary" : ""}`}>All</Link>
        {ROLES.map((r) => (
          <Link key={r} href={`/?role=${r}`} className={`btn py-1 min-h-8 ${roleFilter === r ? "btn-primary" : ""}`}>
            {ROLE_LABELS[r]}
          </Link>
        ))}
      </nav>

      <section className="card p-0 overflow-hidden" aria-labelledby="attention">
        <h2 id="attention" className="px-4 py-3 text-sm font-semibold border-b border-border">Reach out</h2>
        {d.attention.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">Everyone with a cadence is warm. Nice.</p>
        ) : (
          <ul className="divide-y divide-border" data-testid="attention-list">
            {d.attention.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="attention-row">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/people/${p.id}`} className="font-medium hover:underline">{p.fullName}</Link>
                    <HealthBadge health={p.health} />
                    <span className="text-xs text-muted">
                      {daysAgo(p.lastInteractionAt)} · every {p.cadenceDays}d
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <RoleChips roles={p.roles} />
                    {p.lastSummary && <span className="truncate">Last: {p.lastSummary}</span>}
                  </div>
                </div>
                <LogInteractionDialog personId={p.id} personName={p.fullName} label="Log" className="btn btn-primary" />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="card" aria-labelledby="followups">
          <h2 id="followups" className="text-sm font-semibold mb-3">Open follow-ups</h2>
          {d.followUps.length === 0 ? (
            <p className="text-sm text-muted">Nothing due this week.</p>
          ) : (
            <ul className="grid gap-2" data-testid="followup-list">
              {d.followUps.map((f) => (
                <li key={f.id} className="flex items-start justify-between gap-2">
                  <FollowUpCheckbox id={f.id} done={false} label={f.description} />
                  <span className="shrink-0 text-xs text-muted text-right">
                    <Link href={`/people/${f.personId}`} className="hover:underline">{f.personName}</Link>
                    <br />
                    <span className={f.overdue ? "text-red-700" : ""}>{relativeDue(f.dueAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="reminders">
          <h2 id="reminders" className="text-sm font-semibold mb-3">Reminders</h2>
          {d.reminders.length === 0 ? (
            <p className="text-sm text-muted">No reminders this week.</p>
          ) : (
            <ul className="grid gap-2">
              {d.reminders.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    <Link href={`/people/${r.personId}`} className="font-medium hover:underline">{r.personName}</Link>
                    <span className="text-muted"> · {r.reason} · </span>
                    <span className={r.overdue ? "text-red-700" : "text-muted"}>{relativeDue(r.dueAt)}</span>
                  </span>
                  <ReminderControls id={r.id} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
