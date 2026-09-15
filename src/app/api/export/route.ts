import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { followUps, interactions, people, personTags, reminders, tags } from "@/db/schema";
import { requireUserId } from "@/server/auth";

export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  const s = v == null ? "" : Array.isArray(v) ? v.join(";") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request): Promise<Response> {
  const userId = await requireUserId();
  const db = getDb();
  const format = new URL(req.url).searchParams.get("format") ?? "json";

  const [ppl, tagRows, ptRows, ints, fus, rems] = await Promise.all([
    db.select().from(people).where(eq(people.userId, userId)),
    db.select().from(tags).where(eq(tags.userId, userId)),
    db.select({ personId: personTags.personId, name: tags.name }).from(personTags).innerJoin(tags, eq(tags.id, personTags.tagId)).where(eq(tags.userId, userId)),
    db.select().from(interactions).where(eq(interactions.userId, userId)),
    db.select().from(followUps).where(eq(followUps.userId, userId)),
    db.select().from(reminders).where(eq(reminders.userId, userId)),
  ]);
  const tagsByPerson = new Map<string, string[]>();
  for (const r of ptRows) tagsByPerson.set(r.personId, [...(tagsByPerson.get(r.personId) ?? []), r.name]);

  if (format === "csv") {
    const cols = ["fullName", "preferredName", "email", "phone", "company", "title", "location", "howWeMet", "roles", "tags", "cadenceDays", "lpStage", "dealSourceQuality", "notes"] as const;
    const lines = [cols.join(",")];
    for (const p of ppl) {
      lines.push(cols.map((c) => csvCell(c === "tags" ? tagsByPerson.get(p.id) ?? [] : p[c])).join(","));
    }
    return new NextResponse(lines.join("\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="people.csv"' },
    });
  }

  const body = {
    exportedAt: new Date().toISOString(),
    people: ppl.map((p) => ({ ...p, tags: tagsByPerson.get(p.id) ?? [] })),
    tags: tagRows,
    interactions: ints,
    followUps: fus,
    reminders: rems,
  };
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="relationship-os.json"' },
  });
}
