import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

function createDb(url: string) {
  const client = postgres(url, { max: 10, prepare: false });
  return drizzle(client, { schema, casing: "snake_case" });
}

let cached: Db | undefined;

/** Lazily created singleton so `next build` does not need a database. */
export function getDb(): Db {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  cached = createDb(url);
  return cached;
}

/** Test-only: close the pool so vitest can exit. */
export async function closeDb(): Promise<void> {
  if (!cached) return;
  await cached.$client.end();
  cached = undefined;
}
