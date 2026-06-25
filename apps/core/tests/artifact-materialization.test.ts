/**
 * Artifact workspace routing and secure working-copy tests.
 */

import { describe, expect, it, mock } from "bun:test";
import type { ResolvedWorkspace } from "../functions/_shared/workspaces.ts";
import {
  artifactWorkspacePath,
  materializeArtifact,
  selectArtifactWorkspace,
} from "../functions/harness-processing/artifact-materialization.ts";

const ARTIFACT_ID = `art_${"a".repeat(64)}`;

describe("artifact workspace materialization", () => {
  it("automatically selects exactly one writable workspace", () => {
    const writable = workspace("attachments", true);
    expect(selectArtifactWorkspace([workspace("reference", false), writable])).toBe(writable);
    expect(selectArtifactWorkspace([writable, workspace("other", true)])).toBeNull();
    expect(selectArtifactWorkspace([workspace("reference", false)])).toBeNull();
  });

  it("requires an explicitly named writable workspace when routing is ambiguous", () => {
    const first = workspace("first", true);
    const second = workspace("attachments", true);
    expect(selectArtifactWorkspace([first, second], "attachments")).toBe(second);
    expect(selectArtifactWorkspace([first, workspace("attachments", false)], "attachments")).toBeNull();
  });

  it("writes an integrity-checked artifact-storage copy as non-executable", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const ensureDirectories = mock(async () => {});
    const writeObject = mock(async () => bytes.byteLength);
    const load = mock(async () => ({
      status: "ready" as const,
      artifact: {
        artifactId: ARTIFACT_ID,
        filename: "report.zip",
        mediaType: "application/zip",
        kind: "document" as const,
        size: bytes.byteLength,
        sha256: "b".repeat(64),
        state: "ready" as const,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
      bytes,
    }));

    const result = await materializeArtifact({
      artifactId: ARTIFACT_ID,
      filename: "report.zip",
      mediaType: "application/zip",
      kind: "document",
      capabilities: { imageMediaTypes: [], fileMediaTypes: [] },
      workspaces: [workspace("attachments", true)],
      service: { get: mock(async () => null), read: mock(async () => ({ status: "unavailable", reason: "unused" })), load } as never,
      filesystemBucket: "filesystem",
      dependencies: { ensureDirectories, writeObject },
    });

    expect(result).toEqual({
      workspaceName: "attachments",
      workspacePath: `.artifacts/${ARTIFACT_ID}/report.zip`,
    });
    expect(load).toHaveBeenCalledWith(ARTIFACT_ID, 20 * 1024 * 1024);
    expect(writeObject).toHaveBeenCalledWith(
      "filesystem",
      expect.stringContaining(`/.artifacts/${ARTIFACT_ID}/report.zip`),
      bytes,
      expect.objectContaining({ executable: false, contentType: "application/zip" }),
    );
  });

  it("does not copy natively supported files in complex mode", async () => {
    const load = mock(async () => { throw new Error("must not load"); });
    expect(await materializeArtifact({
      artifactId: ARTIFACT_ID,
      filename: "report.pdf",
      mediaType: "application/pdf",
      kind: "document",
      config: { workspace: { materialize: "complex" } },
      capabilities: { imageMediaTypes: [], fileMediaTypes: ["application/pdf"] },
      workspaces: [workspace("attachments", true)],
      service: { load } as never,
      filesystemBucket: "filesystem",
    })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects paths that can escape the reserved artifact directory", () => {
    expect(() => artifactWorkspacePath("art_bad", "file.txt")).toThrow("Artifact ID");
    expect(() => artifactWorkspacePath(ARTIFACT_ID, "../file.txt")).toThrow("filename");
    expect(() => artifactWorkspacePath(ARTIFACT_ID, "nested/file.txt")).toThrow("filename");
  });
});

function workspace(name: string, writable: boolean): ResolvedWorkspace {
  return {
    name,
    workspaceId: `ws_${name}`,
    namespace: `fs_${name}`,
    config: { storage: { provider: "s3" } },
    ...(writable ? { sandbox: { provider: "lambda" as const } } : {}),
  };
}
