import { defineAgent, definePancakeChannel, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const mediaSandbox = defineSandbox({
  name: "pancake-media-sandbox",
  config: { provider: "lambda", permissionMode: "bypass", network: { mode: "deny-all" } },
});

export const outbox = defineWorkspace({
  name: "outbox",
  description: "Files the Pancake agent can create and send",
  config: { storage: { provider: "s3" } },
});

export const pancake = definePancakeChannel({
  pageId: env.PANCAKE_PAGE_ID,
  pageAccessToken: env.PANCAKE_PAGE_ACCESS_TOKEN,
  webhookSecret: env.PANCAKE_WEBHOOK_SECRET,
  senderId: env.PANCAKE_SENDER_ID,
  ignoreTagIds: process.env.PANCAKE_IGNORE_TAG_IDS?.split(",").map((value) => value.trim()).filter(Boolean),
  streaming: { mode: "chunk" },
  actions: { attachments: true },
  mediaMaxMb: 20,
});

export const agent = defineAgent({
  name: "pancake-channel-agent",
  config: {
    provider: { minimax: { apiKey: env.MINIMAX_API_KEY } },
    model: { provider: "minimax", modelId: "MiniMax-M3" },
    agent: {
      system: [
        "You are a concise customer support assistant.",
        "Incoming Pancake photos and videos are automatic conversation artifacts; there is no attachment command.",
        "When asked to send a new photo or video in an inbox conversation, create it in the outbox workspace and use channel_message.",
      ].join("\n"),
    },
    channels: [pancake],
    sandbox: mediaSandbox,
    workspaces: [outbox],
    artifacts: {
      workspace: { name: "outbox", materialize: "complex" },
      processing: { audio: "reject", archives: "workspace", unsupportedFiles: "workspace" },
    },
  },
});
