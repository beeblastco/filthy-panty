/**
 * Channel lifecycle runner utilities.
 * Keep generic hook execution here so handler.ts remains orchestration-focused.
 */

import type { SystemModelMessage } from "ai";
import type { ChannelInboundEvent } from "../integrations.ts";
import { logError, logInfo } from "../../_shared/log.ts";
import type {
  ChannelLifecycleComponent,
  ChannelLifecycleContext,
  ChannelSendResult,
} from "./types.ts";

export function createChannelLifecycleContext(event: ChannelInboundEvent): ChannelLifecycleContext {
  return {
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    channelName: event.channelName,
    content: event.content,
    source: event.source,
  };
}

export async function runBeforeSessionAppend(
  components: ChannelLifecycleComponent[] | undefined,
  context: ChannelLifecycleContext,
): Promise<{ shouldContinue: boolean }> {
  for (const component of components ?? []) {
    const preparation = await component.beforeSessionAppend?.(context);
    if (preparation && !preparation.shouldContinue) {
      logInfo("Channel request stopped by lifecycle preparation", {
        eventId: context.eventId,
        conversationKey: context.conversationKey,
        component: component.name,
        reason: preparation.reason ?? "lifecycle_preparation_blocked",
      });
      return { shouldContinue: false };
    }
  }

  return { shouldContinue: true };
}

export async function runBeforeModel(
  components: ChannelLifecycleComponent[] | undefined,
  context: ChannelLifecycleContext,
): Promise<{ shouldContinue: boolean; system: SystemModelMessage[] }> {
  const system: SystemModelMessage[] = [];
  for (const component of components ?? []) {
    const result = await component.beforeModel?.(context);
    if (result?.shouldContinue === false) {
      logInfo("Channel request stopped by lifecycle context", {
        eventId: context.eventId,
        conversationKey: context.conversationKey,
        component: component.name,
        reason: result.reason ?? "lifecycle_context_blocked",
      });
      return { shouldContinue: false, system };
    }

    if (result?.system) {
      system.push(...result.system);
    }
  }

  return { shouldContinue: true, system };
}

export async function runAfterChannelSend(
  components: ChannelLifecycleComponent[] | undefined,
  context: ChannelLifecycleContext,
  result: ChannelSendResult,
): Promise<void> {
  await Promise.all((components ?? []).map(async (component) => {
    if (!component.afterChannelSend) {
      return;
    }

    await component.afterChannelSend(context, result).catch((err) => {
      logError("Failed to run channel lifecycle after-send hook", {
        eventId: context.eventId,
        conversationKey: context.conversationKey,
        component: component.name,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }));
}
