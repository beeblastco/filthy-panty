import {
  defineAgent,
  defineRemoteArtifactDriver,
  defineSandbox,
  defineTelegramChannel,
  defineWorkspace,
  env,
} from "filthy-panty";

const artifactDriverEndpoint = process.env.ARTIFACT_DRIVER_ENDPOINT ?? "https://storage.example.com/filthy-panty/artifacts";
const artifactDriverPublicBase = process.env.ARTIFACT_DRIVER_PUBLIC_BASE_URL ?? "https://storage.example.com";

export const artifactStorage = defineRemoteArtifactDriver({
  name: "telegram-artifact-storage",
  config: {
    endpoint: artifactDriverEndpoint,
    signingSecret: env.ARTIFACT_DRIVER_SIGNING_SECRET,
    allowedHosts: [...new Set([
      new URL(artifactDriverEndpoint).hostname,
      new URL(artifactDriverPublicBase).hostname,
    ])],
  },
});

export const mediaSandbox = defineSandbox({
  name: "telegram-media-sandbox",
  config: {
    provider: "lambda",
    permissionMode: "bypass",
    network: { mode: "deny-all" },
  },
});

export const outbox = defineWorkspace({
  name: "outbox",
  description: "Files the Telegram agent can create and send",
  config: {
    storage: { provider: "s3" },
  },
});

export const telegram = defineTelegramChannel({
  botToken: env.TELEGRAM_BOT_TOKEN,
  webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  allowedChatIds: [Number(process.env.TELEGRAM_ALLOWED_CHAT_ID ?? "0")],
  reactionEmoji: "\u{1F440}",
  streaming: { mode: "edit" },
  actions: { reactions: true, attachments: true },
  mediaMaxMb: 20,
});

export const agent = defineAgent({
  name: "telegram-channel-agent",
  config: {
    provider: { minimax: { apiKey: env.MINIMAX_API_KEY } },
    model: { provider: "minimax", modelId: "MiniMax-M3" },
    agent: {
      system: [
        "You are a concise Telegram assistant.",
        "Incoming attachments are already represented as conversation artifacts; do not ask for an attachment command.",
        "Use the artifact tool for metadata, bounded text and JSON, or rehydration of a model-supported binary from this conversation.",
        "When the user asks you to send a new file, create it in the outbox workspace, then use channel_message to send it.",
        "Complex artifacts are copied from artifact storage into the outbox .artifacts directory; do not extract or execute them automatically.",
      ].join("\n"),
    },
    channels: [telegram],
    sandbox: mediaSandbox,
    workspaces: [outbox],
    artifacts: {
      driver: artifactStorage,
      fallback: "reject",
      workspace: { name: "outbox", materialize: "complex" },
      processing: { audio: "reject", archives: "workspace", unsupportedFiles: "workspace" },
    },
  },
});
