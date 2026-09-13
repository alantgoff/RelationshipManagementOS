"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { DEAL_SOURCE_QUALITIES, LP_STAGES, LP_STAGE_LABELS, type DealSourceQuality, type LpStage } from "@/domain/enums";
import { toDateInput } from "@/lib/format";
import { setFollowUpDone } from "@/server/actions/interactions";
import { archivePerson, restorePerson, setDealSourceQuality, setLpStage } from "@/server/actions/people";
import { completeReminder, createReminder, snoozeReminder } from "@/server/actions/reminders";

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      await fn();
      router.refresh();
    });
  return { pending, run };
}

export function FollowUpCheckbox({ id, done, label }: { id: string; done: boolean; label: string }) {
  const { pending, run } = useAction();
  // Optimistic: flip immediately, then persist and refresh.
  const [checked, setChecked] = useState(done);
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4"
        checked={checked}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          setChecked(next);
          run(() => setFollowUpDone(id, next));
        }}
        aria-label={`Mark "${label}" ${done ? "open" : "done"}`}
      />
      <span className={checked ? "line-through text-muted" : ""}>{label}</span>
    </label>
  );
}

export function ReminderControls({ id }: { id: string }) {
  const { pending, run } = useAction();
  return (
    <span className="flex gap-1">
      <button type="button" className="btn py-1 min-h-8" disabled={pending} onClick={() => run(() => completeReminder(id))}>Done</button>
      <button type="button" className="btn py-1 min-h-8" disabled={pending} onClick={() => run(() => snoozeReminder(id, 7))}>Snooze 7d</button>
    </span>
  );
}

export function ReminderForm({ personId }: { personId: string }) {
  const { pending, run } = useAction();
  const [reason, setReason] = useState("");
  const [dueAt, setDueAt] = useState(() => toDateInput(new Date(Date.now() + 7 * 86_400_000)));
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await createReminder({ personId, reason, dueAt: new Date(`${dueAt}T09:00:00`) });
          setReason("");
        });
      }}
    >
      <input className="input flex-1 min-w-40" placeholder="Reminder reason" aria-label="Reminder reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
      <input className="input w-40" type="date" aria-label="Reminder date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} required />
      <button type="submit" className="btn" disabled={pending}>Add reminder</button>
    </form>
  );
}

export function LpStageSelect({ personId, value }: { personId: string; value: LpStage | null }) {
  const { pending, run } = useAction();
  return (
    <select
      className="input w-auto"
      aria-label="LP stage"
      value={value ?? ""}
      disabled={pending}
      onChange={(e) => run(() => setLpStage(personId, (e.target.value || null) as LpStage | null))}
    >
      <option value="">Stage not set</option>
      {LP_STAGES.map((s) => (
        <option key={s} value={s}>{LP_STAGE_LABELS[s]}</option>
      ))}
    </select>
  );
}

export function DealQualitySelect({ personId, value }: { personId: string; value: DealSourceQuality | null }) {
  const { pending, run } = useAction();
  return (
    <select
      className="input w-auto"
      aria-label="Deal-source quality"
      value={value ?? ""}
      disabled={pending}
      onChange={(e) => run(() => setDealSourceQuality(personId, (e.target.value || null) as DealSourceQuality | null))}
    >
      <option value="">Quality not set</option>
      {DEAL_SOURCE_QUALITIES.map((q) => (
        <option key={q} value={q}>{q}</option>
      ))}
    </select>
  );
}

export function ArchiveButton({ personId, archived }: { personId: string; archived: boolean }) {
  const { pending, run } = useAction();
  return (
    <button
      type="button"
      className="btn"
      disabled={pending}
      onClick={() => run(() => (archived ? restorePerson(personId) : archivePerson(personId)))}
    >
      {archived ? "Restore" : "Archive"}
    </button>
  );
}
