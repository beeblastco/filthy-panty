export interface ChannelActions {
  sendText(text: string): Promise<void>;
  sendTyping(): Promise<void>;
  reactToMessage(): Promise<void>;
}

export interface InboundMessage {
  eventId: string;
  conversationKey: string;
  channelName: string;
  content: string;
  source: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly name: string;
  authenticate(headers: Record<string, string>, body: string): boolean;
  parse(body: string): InboundMessage | null;
  actions(msg: InboundMessage): ChannelActions;
}
