import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { tags } from "@/db/schema";
import type { LpStage, Role } from "@/domain/enums";
import { defaultCadenceForRoles } from "@/domain/health";

type Db = ReturnType<typeof getDb>;
/** A database handle or a transaction handle. */
export type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Ensure tags exist for this owner and return their ids. */
export async function upsertTags(db: Executor, userId: string, names: string[]): Promise<string[]> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  await db
    .insert(tags)
    .values(unique.map((name) => ({ userId, name })))
    .onConflictDoNothing();
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.name, unique)));
  return rows.map((r) => r.id);
}

/** Apply spec rules: default cadence from roles; committed stage adds committed_lp role. */
export function normalizePerson<T extends { roles: Role[]; cadenceDays?: number | null; lpStage?: LpStage | null }>(
  input: T,
  overrides: Partial<Record<Role, number>>,
): T {
  const roles = [...input.roles];
  if (input.lpStage === "committed" && !roles.includes("committed_lp")) roles.push("committed_lp");
  const cadenceDays = input.cadenceDays ?? defaultCadenceForRoles(roles, overrides);
  return { ...input, roles, cadenceDays };
}
