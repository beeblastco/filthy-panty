/**
 * Optional customer/channel component config helpers.
 * Keep concrete customer behavior out of the harness runtime path.
 */

import {
  type PancakeSupabaseReplyModeConfig,
} from "./pancake/supabase-reply-mode.component.ts";
import type { AgentConfig } from "../_shared/accounts.ts";

export function getPancakeSupabaseReplyModeConfig(
  config: AgentConfig,
): PancakeSupabaseReplyModeConfig | null {
  const channelOptions = getPancakeOptions(config);
  const componentsConfig = channelOptions.components;
  if (componentsConfig === undefined) {
    return null;
  }

  if (!Array.isArray(componentsConfig)) {
    throw new Error("config.channels.pancake.options.components must be an array");
  }

  for (let index = 0; index < componentsConfig.length; index += 1) {
    const componentConfig = recordValue(componentsConfig[index]);
    if (
      componentConfig &&
      componentConfig.enabled !== false &&
      componentConfig.type === "pancake-supabase-reply-mode"
    ) {
      return parsePancakeSupabaseReplyModeConfig(
        componentConfig,
        `config.channels.pancake.options.components[${index}]`,
      );
    }
  }

  return null;
}

function parsePancakeSupabaseReplyModeConfig(
  config: Record<string, unknown>,
  path: string,
): PancakeSupabaseReplyModeConfig {
  const url = requiredString(config.url, `${path}.url`);
  const serviceRoleKey = requiredString(config.serviceRoleKey, `${path}.serviceRoleKey`);

  return { url, serviceRoleKey };
}

function getPancakeOptions(config: AgentConfig): Record<string, unknown> {
  const channelConfig = recordValue(config.channels?.pancake);
  return recordValue(channelConfig?.options) ?? {};
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}
