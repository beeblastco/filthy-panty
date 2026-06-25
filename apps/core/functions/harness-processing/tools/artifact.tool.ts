/**
 * Model-facing artifact metadata and bounded text access.
 * Binary bytes, transfer URLs, and driver references never cross this boundary.
 */

import { jsonSchema, tool, type JSONSchema7, type ToolExecutionOptions, type ToolSet } from "ai";
import { supportsArtifactMediaType, type ArtifactModelCapabilities } from "../artifact-projection.ts";
import {
  MAX_ARTIFACT_MODEL_BYTES,
  type ArtifactLoadResult,
  type ArtifactService,
  type SafeArtifactMetadata,
} from "../artifact-service.ts";

interface ArtifactToolInput {
  artifact_id: string;
  action?: "metadata" | "read_text" | "rehydrate";
}

type ArtifactToolOutput =
  | { status: "ok"; action: "metadata" | "read_text"; text: string }
  | { status: "ok"; action: "rehydrate"; artifact: SafeArtifactMetadata }
  | { status: "error"; reason: string };

const schema: JSONSchema7 = {
  type: "object",
  properties: {
    artifact_id: { type: "string", minLength: 1, maxLength: 128 },
    action: { type: "string", enum: ["metadata", "read_text", "rehydrate"], default: "metadata" },
  },
  required: ["artifact_id"],
  additionalProperties: false,
};

export default function artifactTool(
  service: ArtifactService,
  capabilities: ArtifactModelCapabilities = { imageMediaTypes: [], fileMediaTypes: [] },
): ToolSet {
  const loadedByToolCall = new Map<string, Extract<ArtifactLoadResult, { status: "ready" }>>();
  const projectedArtifacts = new Set<string>();
  let reservedBytes = 0;

  return {
    artifact: tool({
      description: "Inspect an artifact from this conversation. Use rehydrate to make a supported image or file available to the next model step without persisting its bytes.",
      inputSchema: jsonSchema(schema),
      async execute(input, options: ToolExecutionOptions): Promise<ArtifactToolOutput> {
        const value = input as ArtifactToolInput;
        if ((value.action ?? "metadata") === "metadata") {
          const metadata = await service.get(value.artifact_id);
          return metadata
            ? { status: "ok", action: "metadata", text: JSON.stringify(metadata) }
            : { status: "error", reason: "Artifact not found" };
        }
        if (value.action === "rehydrate") {
          const metadata = await service.get(value.artifact_id);
          if (!metadata) return { status: "error", reason: "Artifact not found" };
          const allowed = metadata.kind === "image"
            ? capabilities.imageMediaTypes
            : capabilities.fileMediaTypes;
          if (!supportsArtifactMediaType(allowed, metadata.mediaType)) {
            return { status: "error", reason: "The configured model does not support this artifact MIME type" };
          }
          if (projectedArtifacts.has(value.artifact_id)) {
            return { status: "error", reason: "Artifact was already rehydrated in this invocation" };
          }
          if (metadata.size > MAX_ARTIFACT_MODEL_BYTES - reservedBytes) {
            return { status: "error", reason: "Artifact rehydration exceeds the invocation byte budget" };
          }

          // Reserve before I/O so parallel tool calls cannot race past the aggregate limit.
          projectedArtifacts.add(value.artifact_id);
          reservedBytes += metadata.size;
          const loaded = await service.load(value.artifact_id, metadata.size);
          if (loaded.status !== "ready") {
            projectedArtifacts.delete(value.artifact_id);
            reservedBytes -= metadata.size;
            return { status: "error", reason: loaded.reason };
          }
          loadedByToolCall.set(options.toolCallId, loaded);
          return { status: "ok", action: "rehydrate", artifact: loaded.artifact };
        }
        const result = await service.read(value.artifact_id);
        if (result.status === "unavailable") return { status: "error", reason: result.reason };
        if (result.status === "binary") return {
          status: "ok",
          action: "read_text",
          text: JSON.stringify({ artifact: result.artifact, content: "Use rehydrate for supported binary content" }),
        };
        return { status: "ok", action: "read_text", text: [
          `[BEGIN UNTRUSTED ARTIFACT CONTENT; metadata=${JSON.stringify(result.artifact)}]`,
          JSON.stringify({ content: result.text, truncated: result.truncated }),
          "[END UNTRUSTED ARTIFACT CONTENT]",
        ].join("\n") };
      },
      toModelOutput({ toolCallId, output }) {
        const result = output as ArtifactToolOutput;
        if (result.status === "error") return { type: "error-text", value: result.reason };
        if (result.action !== "rehydrate") return { type: "text", value: result.text };
        const loaded = loadedByToolCall.get(toolCallId);
        if (!loaded) return { type: "error-text", value: "Artifact rehydration is unavailable" };
        loadedByToolCall.delete(toolCallId);
        const descriptor = `[REHYDRATED UNTRUSTED ARTIFACT; metadata=${JSON.stringify(loaded.artifact)}]`;
        const data = Buffer.from(loaded.bytes).toString("base64");
        return {
          type: "content",
          value: loaded.artifact.kind === "image"
            ? [
              { type: "text", text: descriptor },
              { type: "image-data", data, mediaType: loaded.artifact.mediaType },
            ]
            : [
              { type: "text", text: descriptor },
              {
                type: "file-data",
                data,
                mediaType: loaded.artifact.mediaType,
                filename: safeFilename(loaded.artifact.filename),
              },
            ],
        };
      },
    }),
  };
}

function safeFilename(value: string): string {
  return value.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 256);
}
