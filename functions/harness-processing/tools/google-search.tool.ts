/**
 * Google provider search tool for the harness agent.
 * Keep Gemini provider-defined search configuration here.
 */

import type { ToolSet } from "ai";
import type { ToolContext } from "./index.ts";

export default function googleSearchTool(context: ToolContext): ToolSet {
  const { enabled: _enabled, ...googleSearchConfig } = context.config;

  return {
    googleSearch: context.google.tools.googleSearch(googleSearchConfig),
  };
}
