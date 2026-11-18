import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

function createDb(url: string) {
  const client = postgres(url, { max: 10, prepare: false });
  return drizzle(client, { schema, casing: "snake_case" });
}

let cached: Db | undefined;
let lockClient: postgres.Sql | undefined;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/** Lazily created singleton so `next build` does not need a database. */
export function getDb(): Db {
  if (cached) return cached;
  cached = createDb(databaseUrl());
  return cached;
}

/**
 * A separate small pool for advisory-lock transactions. A lock holder keeps its
 * connection for as long as it holds the lock while its own queries go through
 * getDb(), so locks must never draw from that pool, or enough concurrent
 * holders would leave their queries no connection (a deadlock).
 */
export function getLockClient(): postgres.Sql {
  lockClient ??= postgres(databaseUrl(), { max: 20, prepare: false, idle_timeout: 30 });
  return lockClient;
}

/** Test-only: close the pools so vitest can exit. */
export async function closeDb(): Promise<void> {
  const db = cached;
  const locks = lockClient;
  cached = undefined;
  lockClient = undefined;
  await Promise.all([db?.$client.end(), locks?.end()]);
}
