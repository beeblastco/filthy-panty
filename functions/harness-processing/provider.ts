/**
 * Agent-configured provider resolution for harness-processing.
 * Keep provider construction and AI SDK setting projection here.
 */

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createGateway } from "@ai-sdk/gateway";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createMinimax } from "vercel-minimax-ai-provider";
import type { LanguageModel } from "ai";
import type {
  AgentConfig,
  AccountModelProviderName,
  AgentProviderSettings,
} from "../_shared/accounts.ts";

export interface ResolvedModelProvider {
  providerName: AccountModelProviderName;
  provider: unknown;
  model: LanguageModel;
}

export function resolveConfiguredModel(agentConfig: AgentConfig): ResolvedModelProvider {
  const providerName = requireModelProvider(agentConfig);
  const modelId = requireModelId(agentConfig);
  const providerConfig = requireProviderSettings(agentConfig, providerName);

  switch (providerName) {
    case "google":
      return resolveProviderModel(providerName, createGoogleGenerativeAI(providerConfig as never), modelId);
    case "openai":
      return resolveProviderModel(providerName, createOpenAI(providerConfig as never), modelId);
    case "bedrock":
      return resolveProviderModel(providerName, createAmazonBedrock(providerConfig as never), modelId);
    case "gateway":
      return resolveProviderModel(providerName, createGateway(providerConfig as never), modelId);
    case "minimax":
      return resolveProviderModel(providerName, createMinimax(providerConfig as never), modelId);
  }
}

export function modelSettingsFromModelConfig(agentConfig: AgentConfig): Record<string, unknown> {
  const {
    provider: _provider,
    modelId: _modelId,
    options: _options,
    ...settings
  } = agentConfig.model ?? {};

  return settings;
}

function resolveProviderModel(
  providerName: AccountModelProviderName,
  provider: (modelId: string) => LanguageModel,
  modelId: string,
): ResolvedModelProvider {
  return {
    providerName,
    provider,
    model: provider(modelId),
  };
}

function requireModelProvider(agentConfig: AgentConfig): AccountModelProviderName {
  const provider = agentConfig.model?.provider;
  if (!provider) {
    throw new Error("config.model.provider is required");
  }
  return provider;
}

function requireModelId(agentConfig: AgentConfig): string {
  const modelId = agentConfig.model?.modelId;
  if (!modelId) {
    throw new Error("config.model.modelId is required");
  }
  return modelId;
}

function requireProviderSettings(
  agentConfig: AgentConfig,
  providerName: AccountModelProviderName,
): AgentProviderSettings {
  const providerConfig = agentConfig.provider?.[providerName];
  if (!providerConfig) {
    throw new Error(`config.provider.${providerName} is required`);
  }
  if (!providerConfig.apiKey) {
    throw new Error(`config.provider.${providerName}.apiKey is required`);
  }
  return providerConfig;
}
