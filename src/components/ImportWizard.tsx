"use client";

import Papa from "papaparse";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  CSV_TARGETS,
  CSV_TARGET_LABELS,
  findDuplicates,
  mapRows,
  suggestMapping,
  type ColumnMapping,
  type CsvTarget,
} from "@/domain/csv";
import { importPeople, type DuplicateDecision, type ImportResult } from "@/server/actions/import";

interface Existing {
  id: string;
  fullName: string;
  email: string;
}

type Step = "upload" | "map" | "review" | "done";

export function ImportWizard({ existing }: { existing: Existing[] }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [decisions, setDecisions] = useState<Record<number, DuplicateDecision>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const mapped = useMemo(() => mapRows(rows, mapping), [rows, mapping]);
  const duplicates = useMemo(() => findDuplicates(mapped.people, existing), [mapped.people, existing]);

  function onFile(file: File) {
    setError(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const hs = res.meta.fields ?? [];
        if (hs.length === 0) {
          setError("Could not read any columns from that file.");
          return;
        }
        setHeaders(hs);
        setRows(res.data);
        setMapping(suggestMapping(hs));
        setStep("map");
      },
      error: (err) => setError(err.message),
    });
  }

  function toReview() {
    if (!Object.values(mapping).includes("fullName")) {
      setError("Map one column to Full name.");
      return;
    }
    setError(null);
    const initial: Record<number, DuplicateDecision> = {};
    for (const [i, ex] of duplicates) initial[i] = { action: "merge", existingId: ex.id };
    setDecisions(initial);
    setStep("review");
  }

  function confirm() {
    start(async () => {
      try {
        const r = await importPeople({ people: mapped.people, decisions });
        setResult(r);
        setStep("done");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed");
      }
    });
  }

  return (
    <div className="grid gap-4">
      <ol className="flex gap-2 text-xs text-muted" aria-label="Steps">
        {(["upload", "map", "review", "done"] as Step[]).map((s, i) => (
          <li key={s} className={s === step ? "font-semibold text-foreground" : ""}>{i + 1}. {s}</li>
        ))}
      </ol>

      {step === "upload" && (
        <div className="card grid gap-3">
          <label className="label" htmlFor="csv">CSV file</label>
          <input
            id="csv"
            type="file"
            accept=".csv,text/csv"
            className="input"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          <p className="text-xs text-muted">
            First row must be headers. Roles and tags may be separated by commas, semicolons, or pipes.
          </p>
        </div>
      )}

      {step === "map" && (
        <div className="card grid gap-3">
          <p className="text-sm">{rows.length} rows. Map each column, or leave it as Skip.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {headers.map((h) => (
              <label key={h} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate" title={h}>{h}</span>
                <select
                  className="input w-44"
                  value={mapping[h] ?? ""}
                  onChange={(e) => setMapping({ ...mapping, [h]: (e.target.value || null) as CsvTarget | null })}
                >
                  <option value="">Skip</option>
                  {CSV_TARGETS.map((t) => (
                    <option key={t} value={t}>{CSV_TARGET_LABELS[t]}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {mapped.issues.length > 0 && (
            <details className="text-xs text-muted">
              <summary>{mapped.issues.length} row warnings</summary>
              <ul className="mt-1 grid gap-0.5">{mapped.issues.slice(0, 50).map((i, k) => <li key={k}>Row {i.row}: {i.message}</li>)}</ul>
            </details>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={() => setStep("upload")}>Back</button>
            <button type="button" className="btn btn-primary" onClick={toReview}>Preview {mapped.people.length} people</button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="card grid gap-3">
          <p className="text-sm">
            {mapped.people.length} people ready. {duplicates.size} match an existing email.
          </p>
          {duplicates.size > 0 && (
            <ul className="grid gap-2" data-testid="duplicates">
              {[...duplicates.entries()].map(([i, ex]) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2 text-sm">
                  <span>
                    <strong>{mapped.people[i].fullName}</strong> <span className="text-muted">({mapped.people[i].email})</span> matches <strong>{ex.fullName}</strong>
                  </span>
                  <span className="flex gap-1">
                    <button type="button" className={`btn py-1 min-h-8 ${decisions[i]?.action === "merge" ? "btn-primary" : ""}`} onClick={() => setDecisions({ ...decisions, [i]: { action: "merge", existingId: ex.id } })}>Merge</button>
                    <button type="button" className={`btn py-1 min-h-8 ${decisions[i]?.action === "skip" ? "btn-primary" : ""}`} onClick={() => setDecisions({ ...decisions, [i]: { action: "skip" } })}>Skip</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="max-h-64 overflow-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead className="text-left text-muted"><tr><th className="px-2 py-1">Name</th><th className="px-2 py-1">Email</th><th className="px-2 py-1">Roles</th><th className="px-2 py-1">Tags</th></tr></thead>
              <tbody>
                {mapped.people.slice(0, 200).map((p, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-2 py-1">{p.fullName}</td><td className="px-2 py-1">{p.email ?? ""}</td><td className="px-2 py-1">{p.roles.join(", ")}</td><td className="px-2 py-1">{p.tags.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={() => setStep("map")}>Back</button>
            <button type="button" className="btn btn-primary" disabled={pending} onClick={confirm}>{pending ? "Importing…" : "Import"}</button>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div className="card text-sm" data-testid="import-result">
          <p className="font-medium">Import complete</p>
          <p className="text-muted">{result.created} created · {result.merged} merged · {result.skipped} skipped</p>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
