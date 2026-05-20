/**
 * Channel lifecycle component contracts.
 * Keep harness-owned extension hooks here; provider adapters stay in _shared.
 */

import type { SystemModelMessage, UserContent } from "ai";

export interface ChannelLifecycleContext {
  accountId?: string;
  agentId?: string;
  eventId: string;
  conversationKey: string;
  channelName: string;
  content: UserContent;
  source: Record<string, unknown>;
}

export interface ChannelLifecycleDecision {
  shouldContinue: boolean;
  reason?: string;
}

export interface ChannelBeforeModelResult {
  shouldContinue?: boolean;
  system?: SystemModelMessage[];
  reason?: string;
}

export interface ChannelSendResult {
  text: string;
}

export interface ChannelLifecycleComponent {
  readonly name: string;
  beforeSessionAppend?(context: ChannelLifecycleContext): Promise<ChannelLifecycleDecision | void>;
  beforeModel?(context: ChannelLifecycleContext): Promise<ChannelBeforeModelResult | void>;
  afterChannelSend?(context: ChannelLifecycleContext, result: ChannelSendResult): Promise<void>;
}
