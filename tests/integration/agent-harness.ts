import type { ChatMessage, ChatRequest, ChatResult } from "@/agent/llm";
import { defaultMediaDeps } from "@/agent/media";
import { receiveInbound, type AgentDeps } from "@/agent/runtime";
import type { ChannelAdapter, InboundMessage, SendResult } from "@/channels/types";

/** Test doubles for the headless agent: a fake iMessage line and a scripted model. */

export const OWNER_PHONE = "+14155550123";
export const LINE = "+13055550999";
/** Thursday 2026-09-24, 11:00 in New York. */
export const THURSDAY_11AM_NY = new Date("2026-09-24T15:00:00Z");

export class FakeLine implements ChannelAdapter {
  readonly name = "test";
  sent: { to: string; text: string }[] = [];
  typing = 0;
  fail = false;
  private n = 0;
  verify() {
    return true;
  }
  parseInbound(body: unknown) {
    return body as InboundMessage;
  }
  async sendText(to: string, text: string): Promise<SendResult> {
    if (this.fail) throw new Error("provider down");
    this.sent.push({ to, text });
    return { providerMessageId: `out-${++this.n}` };
  }
  async sendTyping() {
    this.typing++;
  }
  texts(): string[] {
    return this.sent.map((s) => s.text);
  }
}

type Step = ChatMessage | ((req: ChatRequest) => ChatMessage) | Error;

/** A model that plays back a script and records every request. */
export function scriptedModel(steps: Step[]) {
  const requests: ChatRequest[] = [];
  let i = 0;
  const llm = async (req: ChatRequest): Promise<ChatResult> => {
    requests.push(JSON.parse(JSON.stringify(req)) as ChatRequest);
    const step = steps[i++];
    if (step === undefined) throw new Error(`Script exhausted after ${i - 1} model calls`);
    if (step instanceof Error) throw step;
    const message = typeof step === "function" ? step(req) : step;
    return { message, finishReason: "stop", provider: "primary", model: "scripted", latencyMs: 1 };
  };
  return { llm, requests, remaining: () => steps.length - i };
}

let callN = 0;
export const toolCall = (name: string, args: Record<string, unknown>): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call_${++callN}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
export const say = (text: string): ChatMessage => ({ role: "assistant", content: text });

export function makeDeps(line: FakeLine, llm: AgentDeps["llm"], now = THURSDAY_11AM_NY): AgentDeps {
  return { adapter: line, llm, media: defaultMediaDeps(), now: () => now, lineNumber: LINE };
}

let inboundN = 0;
export function inbound(text: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return { providerMessageId: `in-${++inboundN}-${Math.random().toString(36).slice(2)}`, from: OWNER_PHONE, to: LINE, text, media: [], receivedAt: new Date(), ...extra };
}

/** Deliver a message like the webhook would, then run the background work. */
export async function text(deps: AgentDeps, body: string | InboundMessage) {
  const msg = typeof body === "string" ? inbound(body) : body;
  const result = await receiveInbound(deps, msg);
  if ("work" in result) await result.work();
  return result;
}

/** The tool result messages the model saw on its Nth call (0-based). */
export function toolResults(req: ChatRequest): string[] {
  return req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
}
