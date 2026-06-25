/**
 * Shared channel contracts.
 * Define the shared HTTP and channel adapter boundaries for inbound webhook traffic.
 */

import type { UserContent } from "ai";

export type ChannelMediaKind = "image" | "file" | "video" | "audio" | "gif";

export interface AttachmentDownloadRequest {
  url: string;
  headers?: Record<string, string>;
  allowedHosts: string[];
}

/** Provider metadata plus a late resolver for short-lived/authenticated media URLs. */
export interface InboundAttachmentCandidate {
  id: string;
  kind: ChannelMediaKind;
  filename?: string;
  mediaType?: string;
  size?: number;
  resolveDownload(): Promise<AttachmentDownloadRequest>;
}

export interface OutboundChannelArtifact {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
  kind: ChannelMediaKind;
}

/** Hard provider limits known before an outbound upload starts. */
export interface OutboundArtifactLimits {
  maxCount?: number;
  maxBytesPerArtifact?: number;
  maxTotalBytes?: number;
}

export interface ChannelActions {
  sendText(text: string): Promise<void>;
  sendTyping(): Promise<void>;
  reactToMessage(): Promise<void>;
  // Optional streaming primitives. A channel that can edit a posted message
  // implements both: beginMessage posts the first partial reply and returns its
  // id; editMessage rewrites it. The shared streaming driver (channel-streaming.ts)
  // uses them for "edit" mode and falls back to chunked sendText when absent. Both
  // format text the same way as sendText.
  beginMessage?(text: string): Promise<string>;
  editMessage?(messageId: string, text: string): Promise<void>;
  // Provider message-length cap for edit/progress streaming (raw chars). The driver
  // rotates into a new message past this; defaults to ~3500 when unset.
  editMaxChars?: number;
  /** Fixed provider reaction values, when the API exposes an enum rather than arbitrary emoji. */
  reactionValues?: readonly string[];
  addReaction?(emoji: string): Promise<void>;
  artifactLimits?: OutboundArtifactLimits;
  sendArtifacts?(artifacts: OutboundChannelArtifact[], text?: string): Promise<void>;
}

export function assertOutboundArtifactLimits(
  artifacts: readonly OutboundChannelArtifact[],
  limits: OutboundArtifactLimits | undefined,
): void {
  if (!limits) return;
  if (limits.maxCount !== undefined && artifacts.length > limits.maxCount) {
    throw new Error(`Channel supports at most ${limits.maxCount} attachments per message`);
  }
  const maxBytesPerArtifact = limits.maxBytesPerArtifact;
  if (maxBytesPerArtifact !== undefined) {
    const oversized = artifacts.find((artifact) => artifact.bytes.byteLength > maxBytesPerArtifact);
    if (oversized) throw new Error(`Attachment exceeds the channel's ${maxBytesPerArtifact} byte limit: ${oversized.filename}`);
  }
  if (limits.maxTotalBytes !== undefined) {
    const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
    if (totalBytes > limits.maxTotalBytes) throw new Error(`Attachments exceed the channel's ${limits.maxTotalBytes} byte total limit`);
  }
}

export interface ChannelRequest {
  method: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  body: string;
}

export interface ChannelResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface InboundMessage {
  eventId: string;
  conversationKey: string;
  channelName: string;
  content: UserContent;
  attachments?: InboundAttachmentCandidate[];
  source: Record<string, unknown>;
}

export interface ParsedChannelMessage {
  kind: "message";
  message: InboundMessage;
  ack?: ChannelResponse;
}

/**
 * Channel parse results describe what the webhook should do before the agent runs.
 * Some providers need an immediate HTTP response, while others can be acknowledged and processed later.
 */
export type ChannelParseResult =
  | ParsedChannelMessage
  | { kind: "ignore"; response?: ChannelResponse }
  | { kind: "response"; response: ChannelResponse };

export interface ChannelAdapter {
  readonly name: string;
  canHandle(req: ChannelRequest): boolean;
  authenticate(req: ChannelRequest): boolean | Promise<boolean>;
  /**
   * Normalize a webhook request into a channel message, provider response, or ignored event.
   * Parsing may be async when a channel must check external state before deciding to run the agent.
   */
  parse(req: ChannelRequest): ChannelParseResult | Promise<ChannelParseResult>;
  actions(msg: InboundMessage): ChannelActions;
}

export function extractText(content: UserContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function isOpenAllowList(raw: string | undefined): boolean {
  return !raw || raw.trim() === "" || raw.trim().toLowerCase() === "open";
}

export function formatChannelErrorText(error: string): string {
  return `Error: ${error}`;
}
