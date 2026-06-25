/**
 * Channel action policy and media-limit configuration tests.
 */

import { describe, expect, it } from "bun:test";
import { normalizeAgentConfig } from "../functions/_shared/storage/agent-config.ts";

describe("channel action policy", () => {
  it("accepts model-action policy and a channel media budget", () => {
    expect(normalizeAgentConfig({
      channels: {
        telegram: {
          actions: { reactions: true, attachments: true },
          mediaMaxMb: 16,
        },
      },
    })).toMatchObject({ channels: { telegram: { actions: { attachments: true }, mediaMaxMb: 16 } } });
    expect(normalizeAgentConfig({
      channels: { pancake: { actions: { attachments: true }, mediaMaxMb: 12 } },
    })).toMatchObject({ channels: { pancake: { actions: { attachments: true }, mediaMaxMb: 12 } } });
  });

  it("rejects invalid policy and media limits", () => {
    expect(() => normalizeAgentConfig({
      channels: { slack: { actions: { attachments: "yes" } } },
    })).toThrow("config.channels.slack.actions.attachments must be a boolean");
    expect(() => normalizeAgentConfig({
      channels: { slack: { mediaMaxMb: 0 } },
    })).toThrow("config.channels.slack.mediaMaxMb must be a number from 1 to 20");
  });
});
