/**
 * Backend table definitions shared by cherry-coke (deploys them) and
 * filthy-panty (reads them remotely). Exported as raw field maps so the
 * consuming `convex/schema.ts` in cherry-coke can merge them with its own
 * dashboard-only tables.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Tenant root. One row per cherry-coke org. The doc id IS the accountId. */
export const accountsFields = {
    orgId: v.string(),
    username: v.string(),
    description: v.optional(v.string()),
    secretHash: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/** Agent configuration, stored encrypted so cherry-coke cannot read provider secrets. */
export const agentsFields = {
    accountId: v.id("accounts"),
    name: v.string(),
    description: v.optional(v.string()),
    encryptedConfig: v.optional(v.string()),
    encryptionIv: v.optional(v.string()),
    encryptionTag: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/** Conversation thread between an account's caller and one of its agents. */
export const conversationsFields = {
    accountId: v.id("accounts"),
    agentId: v.id("agents"),
    title: v.optional(v.string()),
    createdAt: v.number(),
    lastMessageAt: v.number(),
};

/** Message in a conversation. Role + content + arbitrary metadata. */
export const messagesFields = {
    conversationId: v.id("conversations"),
    accountId: v.id("accounts"),
    role: v.union(
        v.literal("system"),
        v.literal("user"),
        v.literal("assistant"),
        v.literal("tool"),
    ),
    content: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
};

/** Skill metadata; binary content lives in S3 under accountId-prefixed keys. */
export const skillsFields = {
    accountId: v.id("accounts"),
    name: v.string(),
    description: v.optional(v.string()),
    s3Key: v.string(),
    sizeBytes: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/** Async job tracking for the harness-processing /async endpoint. */
export const asyncResultsFields = {
    accountId: v.id("accounts"),
    eventId: v.string(),
    status: v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("completed"),
        v.literal("failed"),
    ),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
};

/**
 * Table objects keyed by name. cherry-coke's `convex/schema.ts` spreads this
 * into its `defineSchema` call so the deployed schema is the union of
 * dashboard tables and these backend tables.
 */
export const backendTables = {
    accounts: defineTable(accountsFields)
        .index("by_orgId", ["orgId"])
        .index("by_secretHash", ["secretHash"]),
    agents: defineTable(agentsFields).index("by_accountId", ["accountId"]),
    conversations: defineTable(conversationsFields)
        .index("by_accountId", ["accountId"])
        .index("by_accountId_and_agentId", ["accountId", "agentId"]),
    messages: defineTable(messagesFields)
        .index("by_conversationId", ["conversationId"])
        .index("by_accountId", ["accountId"]),
    skills: defineTable(skillsFields).index("by_accountId", ["accountId"]),
    asyncResults: defineTable(asyncResultsFields)
        .index("by_accountId", ["accountId"])
        .index("by_eventId", ["eventId"]),
};
