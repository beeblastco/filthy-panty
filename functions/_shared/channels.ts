/**
 * Shared channel contracts.
 * Define the shared HTTP and channel adapter boundaries for inbound webhook traffic.
 */

import type { SystemModelMessage, UserContent } from "ai";

export interface ChannelActions {
  sendText(text: string): Promise<void>;
  sendTyping(): Promise<void>;
  reactToMessage(): Promise<void>;
  prepareMessage?(context: ChannelLifecycleContext): Promise<ChannelPreparationResult>;
  loadContext?(context: ChannelLifecycleContext): Promise<ChannelContextResult>;
  recordReply?(context: ChannelLifecycleContext, responseText: string): Promise<void>;
}

export interface ChannelLifecycleContext {
  accountId?: string;
  agentId?: string;
  eventId: string;
  conversationKey: string;
  channelName: string;
  content: UserContent;
  source: Record<string, unknown>;
}

export interface ChannelPreparationResult {
  shouldContinue: boolean;
  reason?: string;
}

export interface ChannelContextResult {
  canReply: boolean;
  system?: SystemModelMessage[];
  reason?: string;
}

export interface ChannelRequest {
  method: string;
  rawPath: string;
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
  source: Record<string, unknown>;
}

export interface ParsedChannelMessage {
  kind: "message";
  message: InboundMessage;
  ack?: ChannelResponse;
}

export type ChannelParseResult =
  | ParsedChannelMessage
  | { kind: "ignore"; response?: ChannelResponse }
  | { kind: "response"; response: ChannelResponse };

export interface ChannelAdapter {
  readonly name: string;
  canHandle(req: ChannelRequest): boolean;
  authenticate(req: ChannelRequest): boolean | Promise<boolean>;
  parse(req: ChannelRequest): ChannelParseResult;
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
