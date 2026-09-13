import Link from "next/link";
import { HealthBadge } from "@/components/HealthBadge";
import { RoleChips } from "@/components/RoleChips";
import { LP_STAGES, LP_STAGE_LABELS, ROLES, ROLE_LABELS, type LpStage, type Role } from "@/domain/enums";
import { daysAgo } from "@/lib/format";
import { listPeople, listTags, type PeopleSort } from "@/server/queries/people";

export const dynamic = "force-dynamic";

type Params = { q?: string; role?: string; tag?: string; sort?: string; view?: string; archived?: string };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const role = (ROLES as readonly string[]).includes(sp.role ?? "") ? (sp.role as Role) : undefined;
  const sort = (["health", "name", "lastContact", "dealSource"] as const).includes(sp.sort as PeopleSort) ? (sp.sort as PeopleSort) : "name";
  const view = sp.view === "lp" ? "lp" : "list";
  const [rows, tags] = await Promise.all([
    listPeople({ q: sp.q, role, tag: sp.tag, sort, includeArchived: sp.archived === "1" }),
    listTags(),
  ]);

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">People <span className="text-muted text-base font-normal">({rows.length})</span></h1>
        <div className="flex gap-2">
          <Link href={`/people?${new URLSearchParams({ ...sp, view: view === "lp" ? "list" : "lp" }).toString()}`} className="btn">
            {view === "lp" ? "List view" : "LP stages"}
          </Link>
          <Link href="/people/new" className="btn btn-primary">+ New person</Link>
        </div>
      </header>

      <form className="card grid gap-2 sm:grid-cols-[1fr_auto_auto_auto_auto]" role="search">
        <input type="hidden" name="view" value={view} />
        <input name="q" className="input" placeholder="Search name, company, tags, notes…" defaultValue={sp.q ?? ""} aria-label="Search" />
        <select name="role" className="input" defaultValue={role ?? ""} aria-label="Role">
          <option value="">All roles</option>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <select name="tag" className="input" defaultValue={sp.tag ?? ""} aria-label="Tag">
          <option value="">All tags</option>
          {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
        </select>
        <select name="sort" className="input" defaultValue={sort} aria-label="Sort">
          <option value="name">Name</option>
          <option value="health">Health</option>
          <option value="lastContact">Last contact</option>
          <option value="dealSource">Deal-source quality</option>
        </select>
        <button className="btn" type="submit">Apply</button>
      </form>

      {view === "lp" ? <LpBoard rows={rows} /> : <PeopleTable rows={rows} />}
      <p className="text-xs text-muted">
        {sp.archived === "1" ? <Link href="/people" className="hover:underline">Hide archived</Link> : <Link href="/people?archived=1" className="hover:underline">Show archived</Link>}
      </p>
    </div>
  );
}

type Row = Awaited<ReturnType<typeof listPeople>>[number];

function PeopleTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="card text-sm text-muted">No people match. <Link href="/people/new" className="underline">Add someone</Link> or <Link href="/import" className="underline">import a CSV</Link>.</p>;
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-border">
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Health</th>
            <th className="px-4 py-2 font-medium hidden sm:table-cell">Roles</th>
            <th className="px-4 py-2 font-medium hidden md:table-cell">Last contact</th>
            <th className="px-4 py-2 font-medium hidden md:table-cell">Cadence</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((p) => (
            <tr key={p.id} data-testid="person-row" className={p.archivedAt ? "opacity-60" : ""}>
              <td className="px-4 py-2">
                <Link href={`/people/${p.id}`} className="font-medium hover:underline">{p.fullName}</Link>
                {p.company && <span className="text-muted"> · {p.company}</span>}
                {p.dealSourceQuality && <span className="ml-2 rounded bg-background px-1.5 text-xs text-muted">deals: {p.dealSourceQuality}</span>}
              </td>
              <td className="px-4 py-2"><HealthBadge health={p.health} /></td>
              <td className="px-4 py-2 hidden sm:table-cell"><RoleChips roles={p.roles} tags={p.tags} /></td>
              <td className="px-4 py-2 hidden md:table-cell text-muted">{daysAgo(p.lastInteractionAt)}</td>
              <td className="px-4 py-2 hidden md:table-cell text-muted">{p.cadenceDays ? `${p.cadenceDays}d` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LpBoard({ rows }: { rows: Row[] }) {
  const lps = rows.filter((p) => p.roles.includes("prospective_lp") || p.roles.includes("committed_lp"));
  const groups: Record<LpStage | "unset", Row[]> = { unset: [], identified: [], intro_made: [], first_meeting: [], data_room: [], soft_commit: [], committed: [], passed: [] };
  for (const p of lps) groups[p.lpStage ?? "unset"].push(p);
  const cols: (LpStage | "unset")[] = ["unset", ...LP_STAGES];
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[56rem] grid-cols-8 gap-2">
        {cols.map((s) => (
          <section key={s} className="card p-2" aria-label={s === "unset" ? "Stage not set" : LP_STAGE_LABELS[s]}>
            <h3 className="mb-2 text-xs font-semibold text-muted">{s === "unset" ? "Not set" : LP_STAGE_LABELS[s]} <span className="font-normal">({groups[s].length})</span></h3>
            <ul className="grid gap-2">
              {groups[s].map((p) => (
                <li key={p.id} className="rounded border border-border p-2 text-sm">
                  <Link href={`/people/${p.id}`} className="font-medium hover:underline">{p.fullName}</Link>
                  <div className="mt-1"><HealthBadge health={p.health} /></div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
