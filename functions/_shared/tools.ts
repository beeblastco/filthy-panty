interface ToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: {
      json: Record<string, unknown>;
    };
  };
}

export interface ToolConfig {
  tools: ToolSpec[];
}

export interface ToolInput {
  toolUseId: string;
  input: Record<string, unknown>;
  context: {
    conversationKey: string;
    latestUserMessage: string;
  };
}

export interface ToolOutput {
  toolUseId: string;
  content: string;
  status: "success" | "error";
  action?: string;
  replyText?: string;
}

export function buildToolConfig(): ToolConfig {
  return {
    tools: [],
  };
}
