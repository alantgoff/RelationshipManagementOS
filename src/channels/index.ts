import { createSendblueAdapter, sendblueConfigFromEnv } from "./sendblue";
import type { ChannelAdapter } from "./types";

/** The configured channel. Throws when its credentials are missing. */
export function getChannelAdapter(): ChannelAdapter {
  return createSendblueAdapter(sendblueConfigFromEnv());
}

export function channelConfigured(): boolean {
  return Boolean(process.env.SENDBLUE_API_KEY_ID && process.env.SENDBLUE_API_SECRET && process.env.SENDBLUE_SIGNING_SECRET);
}

/** The line's number as shown to the owner in Settings. */
export function lineNumberForDisplay(): string | null {
  return process.env.SENDBLUE_FROM_NUMBER || null;
}
