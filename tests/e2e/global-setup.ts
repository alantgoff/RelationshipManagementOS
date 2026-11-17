import postgres from "postgres";

/** Empty the e2e database so each run starts from the same state. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://rmos:rmos@localhost:5432/rmos_test";
  const sql = postgres(url, { max: 1 });
  try {
    await sql`truncate table notification_log, thread_summaries, memory_facts, pending_actions, agent_actions, agent_turns, channel_messages, channel_bindings, follow_ups, reminders, interactions, person_tags, tags, people, user_settings restart identity cascade`;
  } finally {
    await sql.end();
  }
}
