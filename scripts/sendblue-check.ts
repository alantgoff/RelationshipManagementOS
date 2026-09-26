/**
 * Step 1 of the v2 plan: confirm the agent can text you first on Sendblue.
 *
 * 1. Create a Sendblue sandbox account and text its line once from your phone.
 * 2. Put SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET and OWNER_PHONE in .env.local
 *    (SENDBLUE_FROM_NUMBER too if your plan requires it).
 * 3. npm run check:sendblue
 *
 * It sends a typing indicator and one message, then prints Sendblue's raw
 * responses so field names can be checked against src/channels/sendblue.ts.
 * If the message arrives as a blue bubble, proactive iMessage works.
 */
import { config } from "dotenv";
import { createSendblueAdapter, sendblueConfigFromEnv } from "../src/channels/sendblue";
import { toE164 } from "../src/channels/types";

config({ path: ".env.local" });
config();

async function main() {
  const owner = toE164(process.env.OWNER_PHONE ?? "");
  if (!owner) {
    console.error("Set OWNER_PHONE (your iPhone number) in .env.local");
    process.exit(2);
  }
  const adapter = createSendblueAdapter(sendblueConfigFromEnv());

  try {
    await adapter.sendTyping?.(owner);
    console.log("Typing indicator: sent");
  } catch (err) {
    console.log(`Typing indicator: not available (${err instanceof Error ? err.message : err})`);
  }

  const result = await adapter.sendText(
    owner,
    "Relationship OS check: this message was started by the agent, not a reply. Tap 👍 if it arrived as a blue bubble.",
  );
  console.log("Send result:", result);
  console.log("\nNext: confirm it arrived as iMessage (blue), then configure the webhook URL in Sendblue once Phase 1 ships.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
