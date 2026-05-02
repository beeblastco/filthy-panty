/**
 * Agent-side harness core.
 * Keep turn context assembly, model invocation, and tools orchestration here. 
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGateway } from "@ai-sdk/gateway";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAI } from "@ai-sdk/openai";
import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ToolSet,
} from "ai";
import type { AccountConfig } from "../_shared/accounts.ts";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { Session, TurnContextSnapshot } from "./session.ts";
import { createTools } from "./tools/index.ts";

const GOOGLE_MODEL_ID = requireEnv("GOOGLE_MODEL_ID");
const MAX_AGENT_ITERATIONS = Number(requireEnv("MAX_AGENT_ITERATIONS"));
const DEFAULT_GOOGLE_PROVIDER_OPTIONS = {
  google: {
    thinkingConfig: {
      thinkingLevel: "high",
    },
  },
} as const;

const google = createGoogleGenerativeAI({ apiKey: requireEnv("GOOGLE_API_KEY") });

export interface AgentReplyHooks {
  onFinalText(text: string): Promise<void>;
  onErrorText(error: string): Promise<void>;
}

export async function runAgentLoop(
  session: Session,
  turnContext: TurnContextSnapshot,
  accountConfig: AccountConfig,
  reply?: AgentReplyHooks,
) {
  let didFail = false;
  let failureText: string | null = null;
  let promptContext = turnContext.promptContext;

  const tools = {
    ...createTools({
      conversationKey: session.conversationKey,
      filesystemNamespace: session.filesystemNamespace(),
      google: createGoogleProvider(accountConfig),
    }, accountConfig),
  } satisfies ToolSet;
  const enabledTools = Object.keys(tools).length > 0 ? tools : undefined;
  const configuredModel = resolveConfiguredModel(accountConfig);
  const modelSettings = streamTextSettingsFromModelConfig(accountConfig);
  const providerOptions = accountConfig.model?.options ?? DEFAULT_GOOGLE_PROVIDER_OPTIONS;

  const stream = streamText({
    maxOutputTokens: 16000,
    ...modelSettings,
    model: configuredModel,
    system: turnContext.system,
    messages: turnContext.messages,
    ...(enabledTools ? { tools: enabledTools } : {}),
    providerOptions: providerOptions as never,
    stopWhen: stepCountIs(accountConfig.maxAgentIterations ?? MAX_AGENT_ITERATIONS),
    prepareStep: async () => {
      const refreshed = await session.loadRefreshedSystemPromptParts({
        promptContext: promptContext,
        ephemeralSystem: turnContext.ephemeralSystem,
      });
      promptContext = refreshed.promptContext;

      return {
        system: refreshed.system,
      };
    },
    onError: async ({ error }) => {
      const errorText = error instanceof Error ? error.message : String(error);
      didFail = true;
      failureText = errorText;
      logError("Agent loop failed", {
        conversationKey: session.conversationKey,
        error: errorText,
      });

      await reply?.onErrorText(errorText).catch(() => { });
    },
    onFinish: async ({ response, text }) => {
      const finalText = text.trim();

      try {
        await session.persistModelMessages(response.messages);

        if (!finalText) {
          const errorText = "Model returned empty response";
          didFail = true;
          failureText = errorText;
          logError(errorText, {
            conversationKey: session.conversationKey,
            eventId: session.eventId,
          });
          await reply?.onErrorText(errorText).catch(() => { });
          return;
        }

        await reply?.onFinalText(finalText);
        logInfo("Processing complete", { conversationKey: session.conversationKey });
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        didFail = true;
        failureText = errorText;
        logError("Post-generation steps failed", {
          conversationKey: session.conversationKey,
          error: errorText,
        });

        await reply?.onErrorText(errorText).catch(() => { });
      }
    },
  });

  return Object.assign(stream, {
    didFail: () => didFail,
    failureText: () => failureText,
  });
}

function resolveConfiguredModel(accountConfig: AccountConfig): LanguageModel {
  const provider = accountConfig.model?.provider ?? "google";
  const modelId = accountConfig.model?.modelId ?? accountConfig.model?.modelid ?? accountConfig.modelId ?? GOOGLE_MODEL_ID;

  switch (provider) {
    case "google":
      return createGoogleProvider(accountConfig)(modelId);
    case "openai":
      return createOpenAI(accountConfig.provider?.openai as never)(modelId);
    case "bedrock":
      return createAmazonBedrock(accountConfig.provider?.bedrock as never)(modelId);
    case "gateway":
      return createGateway(accountConfig.provider?.gateway as never)(modelId);
  }
}

function createGoogleProvider(accountConfig: AccountConfig) {
  const config = accountConfig.provider?.google;
  return config === undefined
    ? google
    : createGoogleGenerativeAI(config as never);
}

function streamTextSettingsFromModelConfig(accountConfig: AccountConfig): Record<string, unknown> {
  const {
    provider: _provider,
    modelId: _modelId,
    modelid: _modelid,
    options: _options,
    ...settings
  } = accountConfig.model ?? {};

  return settings;
}
