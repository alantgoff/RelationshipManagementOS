/**
 * Seed a realistic demo network for local exploration.
 *
 *   npm run seed:demo            # seeds DEV_USER_ID (default "dev-user") if it has no people
 *   npm run seed:demo -- --reset # deletes that user's data first
 *
 * Dates are relative to today so relationship health looks right whenever
 * you run it. Refuses to touch non-local databases unless --force is given.
 */
import { config } from "dotenv";
import { and, eq, inArray, sql } from "drizzle-orm";

config({ path: ".env.local" });
config();

const DAY = 86_400_000;
const ago = (days: number, hourUtc = 16) => {
  const d = new Date(Date.now() - days * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};
const ahead = (days: number) => new Date(Date.now() + days * DAY);

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  if (!local && !process.argv.includes("--force")) {
    console.error("Refusing to seed demo data into a non-local database. Pass --force if you really mean it.");
    process.exit(2);
  }
  const userId = process.env.DEV_USER_ID ?? "dev-user";
  process.env.DEV_USER_ID = userId;

  const { getDb, closeDb } = await import("../src/db/client");
  const schema = await import("../src/db/schema");
  const { runAsOwner } = await import("../src/server/auth");
  const { createPerson, setLpStage } = await import("../src/server/actions/people");
  const { logInteraction } = await import("../src/server/actions/interactions");
  const { createReminder } = await import("../src/server/actions/reminders");
  const { updateSettings } = await import("../src/server/actions/settings");
  const db = getDb();

  try {
    const existing = await db.select({ id: schema.people.id }).from(schema.people).where(eq(schema.people.userId, userId));
    if (existing.length && !process.argv.includes("--reset")) {
      console.log(`${userId} already has ${existing.length} people. Use --reset to replace them.`);
      return;
    }
    if (existing.length) {
      const ids = existing.map((p) => p.id);
      await db.delete(schema.memoryFacts).where(eq(schema.memoryFacts.userId, userId));
      await db.delete(schema.pendingActions).where(eq(schema.pendingActions.userId, userId));
      await db.delete(schema.interactions).where(inArray(schema.interactions.personId, ids));
      await db.delete(schema.reminders).where(eq(schema.reminders.userId, userId));
      await db.delete(schema.people).where(eq(schema.people.userId, userId));
      await db.delete(schema.tags).where(eq(schema.tags.userId, userId));
      console.log(`Removed ${ids.length} people for ${userId}.`);
    }

    await runAsOwner(userId, "script", async () => {
      await updateSettings({ timezone: "America/New_York", defaultCadences: {} });

      type Seed = Parameters<typeof createPerson>[0];
      const add = async (p: Seed) => (await createPerson(p)).id;

      // Prospective and committed LPs
      const priya = await add({ fullName: "Priya Patel", roles: ["prospective_lp"], company: "Halcyon Family Office", title: "Partner", email: "priya@halcyonfo.com", location: "New York", tags: ["family office", "climate"], howWeMet: "Intro from Leo at a Climate Week dinner" });
      const marcus = await add({ fullName: "Marcus Webb", roles: ["prospective_lp"], company: "Webb Capital", title: "Principal", location: "Boston", tags: ["fund of funds"] });
      const elena = await add({ fullName: "Elena Rossi", roles: ["prospective_lp", "mentor"], company: "Ex-Stripe", title: "Angel", location: "San Francisco", tags: ["operator"] });
      const hiro = await add({ fullName: "Hiro Tanaka", roles: ["committed_lp"], company: "Tanaka Ventures", title: "Founder", location: "Tokyo" });
      const grace = await add({ fullName: "Grace Okafor", roles: ["prospective_lp"], company: "Okafor Endowment", title: "CIO", location: "Chicago", tags: ["endowment"] });
      const ben = await add({ fullName: "Ben Lerner", roles: ["prospective_lp"], company: "Lerner Family Trust", location: "Miami" });

      // Founders and deal sources
      const raj = await add({ fullName: "Raj Mehta", roles: ["founder"], company: "Acme Robotics", title: "CEO", email: "raj@acmerobotics.ai", tags: ["robotics", "portfolio"] });
      const sarah = await add({ fullName: "Sarah Chen", roles: ["deal_source"], company: "Sequoia", title: "Scout", tags: ["ai"], dealSourceQuality: "high" });
      const maya = await add({ fullName: "Maya Singh", roles: ["founder"], company: "Loom Labs", title: "Co-founder", email: "maya@loomlabs.io", tags: ["ai", "pipeline"] });
      const omar = await add({ fullName: "Omar Haddad", roles: ["deal_source", "founder"], company: "Haddad Studio", tags: ["fintech"], dealSourceQuality: "medium" });
      const jules = await add({ fullName: "Jules Moreau", roles: ["founder"], company: "Tidepool Energy", title: "CEO", tags: ["climate", "pipeline"] });

      // Co-investors and friends
      const leo = await add({ fullName: "Leo Park", roles: ["co_investor"], company: "Northstar Ventures", title: "Partner", email: "leo@northstar.vc" });
      const ana = await add({ fullName: "Ana Lima", roles: ["co_investor"], company: "Seedwell", title: "GP" });
      const dana = await add({ fullName: "Dana Lee", roles: ["friend"], location: "Brooklyn", howWeMet: "College roommate" });
      const chris = await add({ fullName: "Chris Doyle", roles: ["friend", "mentor"], title: "Former boss" });
      const mom = await add({ fullName: "Linda Goodwin", preferredName: "Mom", roles: ["family"] });
      await add({ fullName: "Tom Becker", roles: ["prospective_lp"], company: "Becker Family Office", title: "Managing Partner", tags: ["family office"] });

      // LP pipeline
      await setLpStage(priya, "first_meeting");
      await setLpStage(marcus, "data_room");
      await setLpStage(elena, "soft_commit", 250_000);
      await setLpStage(hiro, "committed", 500_000);
      await setLpStage(grace, "intro_made");
      await setLpStage(ben, "passed");

      // History: recent, due, and cold relationships
      const log = (personId: string, type: Parameters<typeof logInteraction>[0]["type"], summary: string, daysAgo: number, extra: Partial<Parameters<typeof logInteraction>[0]> = {}) =>
        logInteraction({ personId, type, summary, occurredAt: ago(daysAgo), ...extra });

      await log(priya, "meeting", "Coffee at Bluestone; keen on Fund I's climate thesis", 27, {
        notes: "Wants to see the pipeline and our first two deals. Decision committee meets in December.",
        followUps: [{ description: "Send Fund I deck and pipeline memo", dueAt: ago(-1) }],
      });
      await log(marcus, "call", "Walked through the data room; questions on fees", 9, {
        followUps: [{ description: "Send fee comparison vs. peer emerging managers", dueAt: ago(2) }],
      });
      await log(elena, "meeting", "Lunch; soft-circled $250k", 15);
      await log(hiro, "email", "Signed the LPA", 40);
      await log(grace, "intro", "Intro via Chris", 52);
      await log(raj, "meeting", "Board prep: Series A timing", 6, {
        followUps: [{ description: "Intro Raj to 3 Series A leads", dueAt: ahead(4) }],
      });
      await log(sarah, "call", "Sent over Loom Labs and two climate deals", 12);
      await log(maya, "meeting", "First pitch: Loom Labs seed round", 5, { notes: "Raising $3M; strong technical team; Sarah's referral." });
      await log(omar, "message", "Congrats on the launch", 70);
      await log(jules, "call", "Intro call; grid storage", 33);
      await log(leo, "meeting", "Dinner; compared notes on robotics deals", 58);
      await log(ana, "email", "Shared co-invest memo on Tidepool", 20);
      await log(dana, "call", "Caught up about her move", 98);
      await log(chris, "meeting", "Breakfast; advice on LP outreach", 64);
      await log(mom, "call", "Sunday call", 11);
      await log(sarah, "intro", "Introduced Maya Singh (Loom Labs)", 8, { introducedPersonId: maya });

      await createReminder({ personId: dana, dueAt: ahead(9), reason: "Dana's birthday" });
      await createReminder({ personId: jules, dueAt: ahead(1), reason: "Check in after Tidepool's pilot results" });

      const fact = (personId: string | null, text: string) =>
        db.insert(schema.memoryFacts).values({ userId, personId, fact: text, sourceKind: "import", validFrom: ago(10) });
      await fact(priya, "Prefers email over calls; assistant is Jamie");
      await fact(raj, "Hates phone calls; text only");
      await fact(elena, "Wants quarterly updates, not monthly");
      await fact(null, "Raising Fund I: $25M target, first close planned for February");
    });

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.people)
      .where(and(eq(schema.people.userId, userId)));
    console.log(`Seeded ${n} people for ${userId}.`);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
