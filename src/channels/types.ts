/**
 * Provider-neutral messaging channel. The agent only sees these types, so
 * swapping Sendblue for Photon, a self-hosted Mac bridge, or Telegram means
 * writing one adapter and changing nothing else.
 */

export interface InboundMedia {
  url: string;
  contentType?: string;
}

export interface InboundMessage {
  /** Provider's unique message id, used for idempotent processing. */
  providerMessageId: string;
  /** Sender in E.164, e.g. +14155550123. */
  from: string;
  /** Our line in E.164, when the provider reports it. */
  to?: string;
  text: string;
  media: InboundMedia[];
  receivedAt: Date;
  /** "imessage" | "sms" | "rcs" | ...; whatever the provider reports. */
  service?: string;
}

export interface SendResult {
  providerMessageId?: string;
  status?: string;
}

export interface ChannelAdapter {
  readonly name: string;
  /** Authenticate a webhook request. Must be constant-time. */
  verify(headers: Headers, rawBody: string): boolean;
  /** Parse a webhook body. Returns null for events that are not new inbound messages. */
  parseInbound(body: unknown): InboundMessage | null;
  sendText(to: string, text: string): Promise<SendResult>;
  sendMedia?(to: string, mediaUrl: string, caption?: string): Promise<SendResult>;
  sendTyping?(to: string): Promise<void>;
}

/** Normalize a US-centric phone number to E.164. Returns null when it can't. */
export function toE164(raw: string, defaultCountry = "1"): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length === 11 && digits.startsWith(defaultCountry)) return `+${digits}`;
  return null;
}
