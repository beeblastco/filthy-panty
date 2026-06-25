/**
 * Artifact projection planner tests.
 * Verify explicit capabilities and safe degradation for unsupported media.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  planArtifactProjection,
  type ProjectableArtifact,
} from "../functions/harness-processing/artifact-projection.ts";

function artifact(
  kind: ProjectableArtifact["kind"],
  mediaType: string,
  bytes = new TextEncoder().encode("artifact bytes"),
): ProjectableArtifact {
  return {
    artifactId: `art_${kind}`,
    filename: `${kind}.bin`,
    mediaType,
    kind,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

const noMedia = { imageMediaTypes: [], fileMediaTypes: [] } as const;

describe("artifact projection planner", () => {
  it("projects images only for explicitly supported vision MIME types", () => {
    const image = artifact("image", "image/png");
    const supported = planArtifactProjection({
      artifact: image,
      capabilities: { imageMediaTypes: ["image/png"], fileMediaTypes: [] },
    });
    expect(supported.mode).toBe("native");
    expect(supported.content[1]).toMatchObject({ type: "image", mediaType: "image/png", image: image.bytes });

    const unsupported = planArtifactProjection({
      artifact: image,
      capabilities: { imageMediaTypes: ["image/jpeg"], fileMediaTypes: ["image/png"] },
    });
    expect(unsupported.mode).toBe("descriptor");
    expect(unsupported.content).toHaveLength(1);
  });

  it.each([
    ["audio", "audio/mpeg"],
    ["video", "video/mp4"],
    ["document", "application/pdf"],
    ["file", "application/octet-stream"],
  ] as const)("projects supported %s content as an AI SDK file part", (kind, mediaType) => {
    const value = artifact(kind, mediaType);
    const plan = planArtifactProjection({
      artifact: value,
      capabilities: { imageMediaTypes: [], fileMediaTypes: [mediaType] },
    });
    expect(plan.mode).toBe("native");
    expect(plan.content[1]).toMatchObject({
      type: "file",
      data: value.bytes,
      mediaType,
      filename: `${kind}.bin`,
    });
  });

  it("supports explicit top-level wildcards without treating an image file capability as vision", () => {
    expect(planArtifactProjection({
      artifact: artifact("audio", "audio/ogg"),
      capabilities: { imageMediaTypes: [], fileMediaTypes: ["audio/*"] },
    }).mode).toBe("native");
    expect(planArtifactProjection({
      artifact: artifact("image", "image/webp"),
      capabilities: { imageMediaTypes: [], fileMediaTypes: ["image/*"] },
    }).mode).toBe("descriptor");
  });

  it.each([
    ["image", "image/png"],
    ["audio", "audio/mpeg"],
    ["video", "video/mp4"],
    ["document", "application/pdf"],
    ["file", "application/octet-stream"],
  ] as const)("degrades unsupported %s content to an artifact tool descriptor", (kind, mediaType) => {
    const plan = planArtifactProjection({ artifact: artifact(kind, mediaType), capabilities: noMedia });
    expect(plan.mode).toBe("descriptor");
    expect(plan.content).toHaveLength(1);
    expect(plan.content[0]).toMatchObject({ type: "text" });
    expect((plan.content[0] as { text: string }).text).toContain(`art_${kind}`);
  });

  it("sanitizes descriptor display fields", () => {
    const value = { ...artifact("file", "application/octet-stream"), filename: "bad\nname.bin" };
    const plan = planArtifactProjection({ artifact: value, capabilities: noMedia });
    expect((plan.content[0] as { text: string }).text).not.toContain("bad\nname");
    expect((plan.content[0] as { text: string }).text).toContain("bad name.bin");
  });

  it("includes a verified workspace working-copy path in the descriptor", () => {
    const value = {
      ...artifact("document", "application/zip"),
      workspaceName: "attachments",
      workspacePath: `.artifacts/art_document/document.bin`,
    };
    const plan = planArtifactProjection({ artifact: value, capabilities: noMedia });
    const descriptor = (plan.content[0] as { text: string }).text;
    expect(descriptor).toContain('"workspace":"attachments"');
    expect(descriptor).toContain('"workspacePath":".artifacts/art_document/document.bin"');
  });
});
