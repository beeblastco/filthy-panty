/**
 * AI SDK adapter for account-uploaded custom tool metadata.
 * Execution is delegated to the Kubernetes custom-tool-executor.ts.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { AccountToolRecord } from "../../_shared/storage/index.ts";
import type { ToolContext } from "./index.ts";
import { executeAccountToolInSandbox } from "./custom-tool-executor.ts";

export default function accountTool(record: AccountToolRecord, context: ToolContext & { accountId: string }): ToolSet {
  return {
    [record.name]: tool({
      description: record.description,
      inputSchema: jsonSchema(record.inputSchema),
      execute: async (input, options) => executeAccountToolInSandbox({
        accountId: context.accountId,
        tool: record,
        input,
        config: context.config,
        options,
      }),
    }),
  };
}
