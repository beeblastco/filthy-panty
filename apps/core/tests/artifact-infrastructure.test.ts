/**
 * Static assertions for artifact storage infrastructure invariants.
 * These complement runtime tests without requiring an SST deployment.
 */

import { describe, expect, it } from "bun:test";

const source = await Bun.file(new URL("../sst.config.ts", import.meta.url)).text();

describe("artifact infrastructure", () => {
  it("keeps staging private, non-versioned, TLS-only, and short-lived", () => {
    expect(source).toContain('new sst.aws.Bucket("ArtifactStaging", {');
    expect(source).toContain("policy: [denyUnlessProjectPrincipal(stage, region, false), denyInsecureTransport()]");
    expect(source).toMatch(/const artifactStagingBucket = new sst\.aws\.Bucket\([\s\S]*?versioning: false/);
    expect(source).toMatch(/ArtifactStagingLifecycle[\s\S]*?filter: \{ prefix: "staging\/" \}[\s\S]*?expiration: \{ days: 1 \}/);
    expect(source).toMatch(/ArtifactStaging[\s\S]*?blockPublicAcls: true[\s\S]*?blockPublicPolicy: true/);
  });

  it("does not grant artifact staging access to sandbox roles", () => {
    expect(source).toMatch(/denyUnlessProjectPrincipal\(stage: string, region: string, includeSandboxRoles = true\)/);
    expect(source).toMatch(/includeSandboxRoles[\s\S]*?SandboxMountNetRole/);
    expect(source).toContain("denyUnlessProjectPrincipal(stage, region, false)");
  });
});
