/**
 * Frontend-only data model types for pnzu-frontend.
 *
 * `pnzu/convex` owns the backend schema. pnzu-frontend only keeps the table types
 * that are referenced directly in the UI.
 */

import type { GenericId } from "convex/values";

export type TableNames =
    | "projects"
    | "environments"
    | "agentConfigs"
    | "agentDeployments";

export type Id<TableName extends string> = GenericId<TableName>;

type SearchToolConfig = {
    searchDepth?: string;
    topic?: string;
    maxResults?: number;
};

type RuntimeVariable = {
    key: string;
    value: string;
};

type RuntimeVariableHash = {
    key: string;
    valueHash: string;
};

type AgentProvider = "openai" | "google" | "bedrock" | "anthropic";

type SystemDoc<TableName extends TableNames> = {
    _id: Id<TableName>;
    _creationTime: number;
};

type ProjectDoc = SystemDoc<"projects"> & {
    authId: string;
    name: string;
    description?: string;
    slug: string;
    updatedAt: number;
};

type EnvironmentDoc = SystemDoc<"environments"> & {
    authId: string;
    projectId: Id<"projects">;
    name: string;
    isDefault: boolean;
    updatedAt: number;
};

type AgentConfigDoc = SystemDoc<"agentConfigs"> & {
    authId: string;
    projectId: Id<"projects">;
    environmentId: Id<"environments">;
    name: string;
    description?: string;
    provider?: AgentProvider;
    modelId: string;
    systemPrompt?: string;
    maxTurns?: number;
    allowedTools?: string[];
    permissionMode: "default" | "bypassPermissions";
    outputFormat?: unknown;
    providerOptions?: unknown;
    temperature?: number;
    maxTokens?: number;
    isSubAgent: boolean;
    publicAccessEnabled?: boolean;
    webSocketEnabled?: boolean;
    memoryToolEnabled?: boolean;
    searchToolEnabled?: boolean;
    searchToolConfig?: SearchToolConfig;
    runtimeVariables?: RuntimeVariable[];
    runtimeVariableHashes?: RuntimeVariableHash[];
    updatedAt: number;
};

type AgentDeploymentDoc = SystemDoc<"agentDeployments"> & {
    authId: string;
    agentConfigId: Id<"agentConfigs">;
    endpointId: string;
    projectSlug?: string;
    environmentSlug?: string;
    status: "active" | "revoked";
    revokedAt?: number;
    updatedAt: number;
};

type TableMap = {
    projects: ProjectDoc;
    environments: EnvironmentDoc;
    agentConfigs: AgentConfigDoc;
    agentDeployments: AgentDeploymentDoc;
};

export type Doc<TableName extends TableNames> = TableMap[TableName];
