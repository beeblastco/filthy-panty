import { DeleteItemCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { ChannelActions } from "./channels.ts";
import { logError } from "./log.ts";

const dynamo = new DynamoDBClient({});

export interface CommandContext {
  conversationKey: string;
  conversationsTableName: string;
  channel: ChannelActions;
}

interface CommandHandler {
  aliases: string[];
  description: string;
  execute(ctx: CommandContext): Promise<string>;
}

const commands: CommandHandler[] = [
  {
    aliases: ["/new", "/start"],
    description: "Clear conversation context and start fresh",
    async execute(ctx) {
      await dynamo.send(
        new DeleteItemCommand({
          TableName: ctx.conversationsTableName,
          Key: { conversationKey: { S: ctx.conversationKey } },
        }),
      );
      return "Context cleared. Starting fresh.";
    },
  },
  {
    aliases: ["/help"],
    description: "Show available commands",
    async execute() {
      const lines = ["Available commands:"];
      for (const cmd of commands) {
        lines.push(`${cmd.aliases[0]} — ${cmd.description}`);
      }
      return lines.join("\n");
    },
  },
];

export function parseCommand(text: string): string | null {
  const token = text.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!token.startsWith("/")) return null;
  const match = commands.find((c) => c.aliases.includes(token));
  return match ? token : null;
}

export async function executeCommand(
  commandToken: string,
  ctx: CommandContext,
): Promise<void> {
  const handler = commands.find((c) => c.aliases.includes(commandToken));
  if (!handler) return;

  try {
    const reply = await handler.execute(ctx);
    await ctx.channel.sendText(reply);
  } catch (err) {
    logError("Command execution failed", {
      command: commandToken,
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.channel.sendText("Something went wrong. Please try again.");
  }
}
