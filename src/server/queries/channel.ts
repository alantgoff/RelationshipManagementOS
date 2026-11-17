import { getAgentPrefs, getBinding, type AgentPrefs } from "@/agent/store";
import { channelConfigured, lineNumberForDisplay } from "@/channels";
import { requireUserId } from "@/server/auth";

export interface AgentStatus {
  configured: boolean;
  line: string | null;
  /** Owner phone with all but the last 4 digits hidden. */
  phoneMasked: string | null;
  connectedAt: Date | null;
  prefs: AgentPrefs;
}

export async function getAgentStatus(): Promise<AgentStatus> {
  const userId = await requireUserId();
  const [binding, prefs] = await Promise.all([getBinding(userId), getAgentPrefs(userId)]);
  const phone = binding?.verifiedAt ? binding.phone : null;
  return {
    configured: channelConfigured(),
    line: lineNumberForDisplay(),
    phoneMasked: phone ? `•••• ${phone.slice(-4)}` : null,
    connectedAt: binding?.verifiedAt ?? null,
    prefs,
  };
}
