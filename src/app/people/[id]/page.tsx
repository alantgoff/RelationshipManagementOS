import Link from "next/link";
import { notFound } from "next/navigation";
import { HealthBadge } from "@/components/HealthBadge";
import { LogInteractionDialog } from "@/components/LogInteractionDialog";
import { ArchiveButton, DealQualitySelect, FollowUpCheckbox, LpStageSelect, ReminderControls, ReminderForm } from "@/components/QuickControls";
import { RoleChips } from "@/components/RoleChips";
import { INTERACTION_TYPE_LABELS } from "@/domain/enums";
import { daysAgo, formatDate, relativeDue } from "@/lib/format";
import { listPeopleForPicker } from "@/server/queries/people";
import { getPerson } from "@/server/queries/person";

export const dynamic = "force-dynamic";

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [p, picker] = await Promise.all([getPerson(id), listPeopleForPicker()]);
  if (!p) notFound();
  const isLp = p.roles.includes("prospective_lp") || p.roles.includes("committed_lp");
  const isDealSource = p.roles.includes("deal_source");
  const openFollowUps = p.timeline.flatMap((i) => i.followUps.filter((f) => !f.completedAt));
  const openReminders = p.reminders.filter((r) => !r.completedAt);

  return (
    <div className="grid gap-6">
      <header className="card grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{p.fullName}{p.preferredName && <span className="text-muted font-normal"> “{p.preferredName}”</span>}</h1>
            <p className="text-sm text-muted">{[p.title, p.company, p.location].filter(Boolean).join(" · ")}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <HealthBadge health={p.health} />
              <span className="text-xs text-muted">last contact {daysAgo(p.lastInteractionAt)}{p.cadenceDays ? ` · every ${p.cadenceDays}d` : " · no cadence"}</span>
            </div>
            <div className="mt-2"><RoleChips roles={p.roles} tags={p.tags} /></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <LogInteractionDialog personId={p.id} personName={p.fullName} people={picker} className="btn btn-primary" />
            <Link href={`/people/${p.id}/edit`} className="btn">Edit</Link>
            <ArchiveButton personId={p.id} archived={p.archivedAt != null} />
          </div>
        </div>
        {(isLp || isDealSource) && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {isLp && <LpStageSelect personId={p.id} value={p.lpStage} />}
            {isDealSource && <DealQualitySelect personId={p.id} value={p.dealSourceQuality} />}
          </div>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          {p.email && <><dt className="text-muted">Email</dt><dd className="truncate"><a className="hover:underline" href={`mailto:${p.email}`}>{p.email}</a></dd></>}
          {p.phone && <><dt className="text-muted">Phone</dt><dd>{p.phone}</dd></>}
          {p.howWeMet && <><dt className="text-muted">How we met</dt><dd className="col-span-1 sm:col-span-3">{p.howWeMet}</dd></>}
          <dt className="text-muted">Intros</dt><dd data-testid="intros">{p.introsGiven} given · {p.introsReceived} received</dd>
        </dl>
        {p.notes && <p className="whitespace-pre-wrap text-sm border-t border-border pt-3">{p.notes}</p>}
      </header>

      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <section aria-labelledby="timeline" className="grid gap-3">
          <h2 id="timeline" className="text-sm font-semibold">Timeline</h2>
          {p.timeline.length === 0 && <p className="card text-sm text-muted">No interactions yet. Log the first one.</p>}
          <ol className="grid gap-3" data-testid="timeline">
            {p.timeline.map((i) => (
              <li key={i.id} className="card grid gap-1" data-testid="timeline-item">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted">{INTERACTION_TYPE_LABELS[i.type]}</span>
                  <time className="text-xs text-muted" dateTime={i.occurredAt.toISOString()}>{formatDate(i.occurredAt)}</time>
                </div>
                <p className="font-medium">{i.summary}</p>
                {i.introducedPersonName && <p className="text-sm text-muted">Introduced to {i.introducedPersonName}</p>}
                {i.viaPersonName && <p className="text-sm text-muted">Introduced by {i.viaPersonName}</p>}
                {i.notes && <p className="whitespace-pre-wrap text-sm">{i.notes}</p>}
                {i.followUps.length > 0 && (
                  <ul className="mt-1 grid gap-1 border-t border-border pt-2">
                    {i.followUps.map((f) => (
                      <li key={f.id} className="flex items-start justify-between gap-2">
                        <FollowUpCheckbox id={f.id} done={f.completedAt != null} label={f.description} />
                        <span className="text-xs text-muted">{relativeDue(f.dueAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </section>

        <aside className="grid gap-6">
          <section className="card" aria-labelledby="open-fu">
            <h2 id="open-fu" className="text-sm font-semibold mb-2">Open follow-ups ({openFollowUps.length})</h2>
            {openFollowUps.length === 0 ? <p className="text-sm text-muted">None.</p> : (
              <ul className="grid gap-1">
                {openFollowUps.map((f) => <li key={f.id}><FollowUpCheckbox id={f.id} done={false} label={f.description} /></li>)}
              </ul>
            )}
          </section>
          <section className="card grid gap-3" aria-labelledby="rem">
            <h2 id="rem" className="text-sm font-semibold">Reminders ({openReminders.length})</h2>
            {openReminders.length > 0 && (
              <ul className="grid gap-2 text-sm">
                {openReminders.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <span>{r.reason} <span className="text-muted">· {relativeDue(r.dueAt)}</span></span>
                    <ReminderControls id={r.id} />
                  </li>
                ))}
              </ul>
            )}
            <ReminderForm personId={p.id} />
          </section>
        </aside>
      </div>
    </div>
  );
}
