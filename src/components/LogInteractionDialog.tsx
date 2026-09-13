"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { INTERACTION_TYPES, INTERACTION_TYPE_LABELS, type InteractionType } from "@/domain/enums";
import { toDateInput } from "@/lib/format";
import { logInteraction } from "@/server/actions/interactions";

interface Props {
  personId: string;
  personName: string;
  /** Other people, for the intro target picker. */
  people?: { id: string; fullName: string }[];
  label?: string;
  className?: string;
}

interface FollowUpRow {
  description: string;
  dueAt: string;
}

export function LogInteractionDialog({ personId, personName, people = [], label = "Log interaction", className = "btn" }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<InteractionType>("meeting");
  const [summary, setSummary] = useState("");
  const [date, setDate] = useState(toDateInput());
  const [notes, setNotes] = useState("");
  const [introduced, setIntroduced] = useState("");
  const [followUps, setFollowUps] = useState<FollowUpRow[]>([]);

  function reset() {
    setType("meeting");
    setSummary("");
    setDate(toDateInput());
    setNotes("");
    setIntroduced("");
    setFollowUps([]);
    setError(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      try {
        await logInteraction({
          personId,
          type,
          summary,
          occurredAt: new Date(`${date}T12:00:00`),
          notes,
          introducedPersonId: type === "intro" && introduced ? introduced : null,
          followUps: followUps
            .filter((f) => f.description.trim())
            .map((f) => ({ description: f.description, dueAt: f.dueAt ? new Date(`${f.dueAt}T12:00:00`) : null })),
        });
        ref.current?.close();
        reset();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save");
      }
    });
  }

  return (
    <>
      <button type="button" className={className} onClick={() => ref.current?.showModal()} data-testid={`log-${personId}`}>
        {label}
      </button>
      <dialog
        ref={ref}
        className="m-auto w-[min(100vw-2rem,32rem)] rounded-lg border border-border bg-card p-0 text-foreground backdrop:bg-black/40"
        onClose={reset}
      >
        <form onSubmit={submit} className="grid gap-3 p-4" aria-label={`Log interaction with ${personName}`}>
          <h2 className="text-base font-semibold">Log interaction · {personName}</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={`type-${personId}`}>Type</label>
              <select id={`type-${personId}`} className="input" value={type} onChange={(e) => setType(e.target.value as InteractionType)}>
                {INTERACTION_TYPES.map((t) => (
                  <option key={t} value={t}>{INTERACTION_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor={`date-${personId}`}>Date</label>
              <input id={`date-${personId}`} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
          </div>
          <div>
            <label className="label" htmlFor={`summary-${personId}`}>Summary</label>
            <input id={`summary-${personId}`} className="input" value={summary} onChange={(e) => setSummary(e.target.value)} required maxLength={300} autoFocus />
          </div>
          {type === "intro" && people.length > 0 && (
            <div>
              <label className="label" htmlFor={`intro-${personId}`}>Introduced to</label>
              <select id={`intro-${personId}`} className="input" value={introduced} onChange={(e) => setIntroduced(e.target.value)}>
                <option value="">Someone not in the app</option>
                {people.filter((p) => p.id !== personId).map((p) => (
                  <option key={p.id} value={p.id}>{p.fullName}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor={`notes-${personId}`}>Notes</label>
            <textarea id={`notes-${personId}`} className="input min-h-20" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <fieldset className="grid gap-2">
            <legend className="label">Follow-ups (promises you made)</legend>
            {followUps.map((f, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2">
                <input
                  className="input"
                  placeholder="Send the deck"
                  aria-label={`Follow-up ${i + 1}`}
                  value={f.description}
                  onChange={(e) => setFollowUps(followUps.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                />
                <input
                  className="input w-36"
                  type="date"
                  aria-label={`Follow-up ${i + 1} due date`}
                  value={f.dueAt}
                  onChange={(e) => setFollowUps(followUps.map((x, j) => (j === i ? { ...x, dueAt: e.target.value } : x)))}
                />
                <button type="button" className="btn" aria-label="Remove follow-up" onClick={() => setFollowUps(followUps.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button type="button" className="btn w-fit" onClick={() => setFollowUps([...followUps, { description: "", dueAt: "" }])}>
              + Add follow-up
            </button>
          </fieldset>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
