/**
 * Harness tool registry.
 * Keep static tool imports and account-configured tool selection here.
 */

import type { ToolSet } from "ai";
import {
  ACCOUNT_TOOL_NAMES,
  type AccountConfig,
  type AccountModelProviderName,
  type AccountToolConfig,
  type AccountToolName,
} from "../../_shared/accounts.ts";
import filesystemTool from "./filesystem.tool.ts";
import googleSearchTool from "./google-search.tool.ts";
import tasksTool from "./tasks.tool.ts";
import { tavilyExtractTool, tavilySearchTool } from "./tavily.tool.ts";

export interface ToolContext {
  conversationKey: string;
  filesystemNamespace: string;
  config: AccountToolConfig;
  modelProviderName: AccountModelProviderName;
  modelProvider: unknown;
}

type ToolFactory = (context: ToolContext) => ToolSet;
const toolFactories = {
  filesystem: filesystemTool,
  tasks: tasksTool,
  tavilySearch: tavilySearchTool,
  tavilyExtract: tavilyExtractTool,
  googleSearch: googleSearchTool,
} satisfies Record<AccountToolName, ToolFactory>;

export function createTools(context: Omit<ToolContext, "config">, accountConfig: AccountConfig): ToolSet {
  const tools: ToolSet = {};

  for (const toolName of ACCOUNT_TOOL_NAMES) {
    const toolConfig = accountConfig.tools?.[toolName];
    if (!isToolEnabled(toolConfig)) {
      continue;
    }

    Object.assign(tools, toolFactories[toolName]({
      ...context,
      config: toolConfig,
    }));
  }

  return tools;
}

function isToolEnabled(config: AccountToolConfig | undefined): config is AccountToolConfig {
  return config !== undefined && config.enabled !== false;
}
