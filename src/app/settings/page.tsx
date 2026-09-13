import { SettingsForm } from "@/components/SettingsForm";
import type { Role } from "@/domain/enums";
import { getSettings } from "@/server/queries/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await getSettings();
  return (
    <div className="grid gap-6 max-w-2xl">
      <h1 className="text-xl font-semibold">Settings</h1>
      <div className="card">
        <SettingsForm timezone={s.timezone} defaultCadences={s.defaultCadences as Partial<Record<Role, number>>} />
      </div>
      <section className="card grid gap-2" aria-labelledby="export">
        <h2 id="export" className="text-sm font-semibold">Export</h2>
        <p className="text-sm text-muted">Download everything you have entered.</p>
        <div className="flex gap-2">
          <a className="btn" href="/api/export?format=json">JSON</a>
          <a className="btn" href="/api/export?format=csv">People CSV</a>
        </div>
      </section>
    </div>
  );
}
