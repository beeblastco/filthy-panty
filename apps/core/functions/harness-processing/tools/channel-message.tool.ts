/**
 * Channel message tool.
 * Expose only capability-gated reactions and workspace artifact sends for the active channel turn.
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type { ChannelActions, ChannelMediaKind } from "../../_shared/channels.ts";
import type { AgentChannelActionsConfig } from "../../_shared/storage/index.ts";
import { requireEnv } from "../../_shared/env.ts";
import { workspaceNamespacePrefix } from "../../_shared/sandbox.ts";
import { readS3BytesBounded } from "../../_shared/s3.ts";
import type { ResolvedWorkspace } from "../../_shared/workspaces.ts";
import { validateAttachmentContent } from "../artifacts.ts";
import { resolveWorkspace, toWorkspaceRelative, toolError, toolText } from "./filesystem-utils.ts";

const FILESYSTEM_BUCKET_NAME = requireEnv("FILESYSTEM_BUCKET_NAME");
const MAX_OUTBOUND_BYTES = 20 * 1024 * 1024;

interface ChannelMessageInput {
  action: "react" | "send_attachment";
  emoji?: string;
  file_path?: string;
  workspace?: string;
  media_type?: string;
  caption?: string;
}

export default function channelMessageTool(context: {
  actions: ChannelActions;
  policy: AgentChannelActionsConfig;
  workspaces: ResolvedWorkspace[];
}): ToolSet {
  const actions = [
    ...(context.policy.reactions === true && context.actions.addReaction ? ["react"] : []),
    ...(context.policy.attachments === true && context.actions.sendArtifacts && context.workspaces.length > 0 ? ["send_attachment"] : []),
  ];
  if (actions.length === 0) return {};

  const schema: JSONSchema7 = {
    type: "object",
    properties: {
      action: { type: "string", enum: actions },
      emoji: context.actions.reactionValues
        ? { type: "string", enum: [...context.actions.reactionValues], description: "Provider-supported reaction. Required for react." }
        : { type: "string", description: "Reaction emoji. Required for react." },
      file_path: { type: "string", description: "Workspace-relative file path. Required for send_attachment." },
      workspace: context.workspaces.length > 1 ? { type: "string", enum: context.workspaces.map((workspace) => workspace.name) } : { type: "string" },
      media_type: { type: "string", description: "Optional IANA media type hint. The server validates it against the file bytes." },
      caption: { type: "string" },
    },
    required: ["action"],
    additionalProperties: false,
  };

  return {
    channel_message: tool({
      description: "Use model-initiated actions explicitly enabled for the current conversation channel.",
      inputSchema: jsonSchema(schema),
      async execute(input) {
        const value = input as ChannelMessageInput;
        if (value.action === "react") {
          if (!context.actions.addReaction || context.policy.reactions !== true) return toolError("Reactions are disabled or unsupported");
          const emoji = value.emoji?.trim();
          if (!emoji || emoji.length > 32) return toolError("emoji is required and must be at most 32 characters");
          if (context.actions.reactionValues && !context.actions.reactionValues.includes(emoji)) {
            return toolError("Reaction is not supported by this channel");
          }
          await context.actions.addReaction(emoji);
          return toolText("Reaction sent");
        }

        if (!context.actions.sendArtifacts || context.policy.attachments !== true) return toolError("Attachments are disabled or unsupported");
        const workspace = resolveWorkspace(context.workspaces, value.workspace);
        if (!workspace) return toolError("A workspace is required to send an attachment");
        if (!value.file_path) return toolError("file_path is required");
        const relative = toWorkspaceRelative(value.file_path);
        const maxBytes = Math.min(MAX_OUTBOUND_BYTES, context.actions.artifactLimits?.maxBytesPerArtifact ?? MAX_OUTBOUND_BYTES);
        let bytes: Uint8Array;
        try {
          bytes = await readS3BytesBounded(
            FILESYSTEM_BUCKET_NAME,
            `${workspaceNamespacePrefix(workspace.namespace)}/${relative}`,
            maxBytes,
          );
        } catch (error) {
          return toolError(error instanceof Error ? error.message : "Unable to read attachment");
        }
        let mediaType: string;
        try {
          mediaType = validateAttachmentContent(bytes, {
            declaredMediaType: value.media_type,
            filename: relative,
          });
        } catch (error) {
          return toolError(error instanceof Error ? error.message : "Unable to validate attachment");
        }
        const kind = mediaKind(mediaType);
        await context.actions.sendArtifacts([{
          bytes,
          filename: relative.split("/").at(-1)!,
          mediaType,
          kind,
        }], value.caption);
        return toolText("Attachment sent");
      },
    }),
  };
}

function mediaKind(mediaType: string): ChannelMediaKind {
  if (mediaType === "image/gif") return "gif";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "file";
}
