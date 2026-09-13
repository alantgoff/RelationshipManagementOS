"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ROLES, ROLE_LABELS, type Role } from "@/domain/enums";
import { DEFAULT_CADENCE_DAYS } from "@/domain/health";
import { updateSettings } from "@/server/actions/settings";

export function SettingsForm({ timezone, defaultCadences }: { timezone: string; defaultCadences: Partial<Record<Role, number>> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [tz, setTz] = useState(timezone);
  const [cad, setCad] = useState<Record<string, string>>(
    Object.fromEntries(ROLES.map((r) => [r, defaultCadences[r]?.toString() ?? ""])),
  );
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const overrides: Record<string, number> = {};
          for (const r of ROLES) if (cad[r]) overrides[r] = Number(cad[r]);
          await updateSettings({ timezone: tz, defaultCadences: overrides as Record<Role, number> });
          setSaved(true);
          router.refresh();
        });
      }}
    >
      <div>
        <label className="label" htmlFor="tz">Timezone</label>
        <input id="tz" className="input max-w-xs" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/New_York" />
      </div>
      <fieldset>
        <legend className="label">Default cadence per role (days)</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {ROLES.map((r) => (
            <label key={r} className="flex items-center justify-between gap-2 text-sm">
              <span>{ROLE_LABELS[r]}</span>
              <input
                className="input w-28"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder={DEFAULT_CADENCE_DAYS[r]?.toString() ?? "none"}
                value={cad[r]}
                onChange={(e) => setCad({ ...cad, [r]: e.target.value })}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : "Save settings"}</button>
        {saved && <span className="text-sm text-muted">Saved</span>}
      </div>
    </form>
  );
}
