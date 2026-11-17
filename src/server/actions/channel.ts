"use server";

import { z } from "zod";
import { createBindingCode, unbind, updateAgentPrefs } from "@/agent/store";
import { lineNumberForDisplay } from "@/channels";
import { parseHM } from "@/lib/time";
import { requireUserId } from "@/server/auth";
import { revalidateApp } from "@/server/revalidate";

/** Start connecting the owner's phone: returns a one-time code to text to the line. */
export async function startPhoneBinding(): Promise<{ code: string; expiresAt: string; line: string | null }> {
  const userId = await requireUserId();
  const { code, expiresAt } = await createBindingCode(userId, "sendblue");
  return { code, expiresAt: expiresAt.toISOString(), line: lineNumberForDisplay() };
}

export async function disconnectPhone(): Promise<void> {
  const userId = await requireUserId();
  await unbind(userId);
  revalidateApp(["/settings"]);
}

const hm = z.string().refine((v) => parseHM(v) !== null, "Use HH:MM, 24-hour");

const agentPrefsInput = z.object({
  briefTime: hm,
  quietStart: hm,
  quietEnd: hm,
  proactiveEnabled: z.boolean(),
  dailyUnpromptedLimit: z.coerce.number().int().min(0).max(10),
});
export type AgentPrefsInput = z.input<typeof agentPrefsInput>;

export async function updateAgentSettings(raw: AgentPrefsInput): Promise<void> {
  const userId = await requireUserId();
  const input = agentPrefsInput.parse(raw);
  await updateAgentPrefs(userId, { ...input, ...(input.proactiveEnabled ? { pausedUntil: null } : {}) });
  revalidateApp(["/settings"]);
}
