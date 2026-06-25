/**
 * Internal artifact control-record API consumed by core's Convex adapter.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { artifactsFields } from "./schema";

const artifactDoc = v.object({
    ...artifactsFields,
    _id: v.id("artifacts"),
    _creationTime: v.number(),
});

const artifactState = v.union(
    v.literal("pending"),
    v.literal("ready"),
    v.literal("failed"),
    v.literal("expired"),
    v.literal("deleted"),
);

const artifactKind = v.union(
    v.literal("image"),
    v.literal("audio"),
    v.literal("video"),
    v.literal("document"),
    v.literal("file"),
);

function assertStateTransition(current: string, next: string): void {
    if (current === next) return;
    const allowed: Record<string, readonly string[]> = {
        pending: ["ready", "failed", "deleted"],
        ready: ["expired", "deleted"],
        failed: ["deleted"],
        expired: ["deleted"],
        deleted: [],
    };
    if (!allowed[current]?.includes(next)) {
        throw new Error(`Invalid artifact state transition: ${current} -> ${next}`);
    }
}

/** Rejects access URLs and oversized or control-character-bearing driver references. */
function validateExternalRef(externalRef: string | undefined): void {
    if (externalRef === undefined) return;
    if (
        externalRef.length === 0
        || externalRef.length > 4096
        || /[\u0000-\u001f\u007f]/.test(externalRef)
        || /^[a-z][a-z0-9+.-]*:/i.test(externalRef)
    ) {
        throw new Error("externalRef must be a bounded opaque reference without a URI scheme");
    }
}

/** Rejects missing, oversized, or control-character-bearing driver IDs. */
function validateDriverId(driverId: string): void {
    if (
        driverId.length === 0
        || driverId.length > 512
        || /[\u0000-\u001f\u007f]/.test(driverId)
    ) {
        throw new Error("driverId must be a bounded non-empty identifier");
    }
}

/** Returns one artifact only when both tenant and conversation scope match. */
export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        conversationKey: v.string(),
        artifactId: v.string(),
    },
    returns: v.union(artifactDoc, v.null()),
    handler: async (ctx, args) => {
        const doc = await ctx.db
            .query("artifacts")
            .withIndex("by_accountId_and_artifactId", (q) =>
                q.eq("accountId", args.accountId).eq("artifactId", args.artifactId),
            )
            .unique();
        if (!doc || doc.conversationKey !== args.conversationKey) return null;

        return doc;
    },
});

/** Lists a bounded number of artifacts in one tenant conversation. */
export const list = internalQuery({
    args: {
        accountId: v.id("accounts"),
        conversationKey: v.string(),
        limit: v.number(),
    },
    returns: v.array(artifactDoc),
    handler: async (ctx, args) => {
        const limit = Math.max(1, Math.min(100, Math.floor(args.limit)));

        return await ctx.db
            .query("artifacts")
            .withIndex("by_accountId_and_conversationKey", (q) =>
                q.eq("accountId", args.accountId).eq("conversationKey", args.conversationKey),
            )
            .order("desc")
            .take(limit);
    },
});

/** Creates one idempotent artifact record keyed by its deterministic artifact ID. */
export const create = internalMutation({
    args: {
        artifactId: v.string(),
        accountId: v.id("accounts"),
        agentId: v.id("agents"),
        conversationKey: v.string(),
        sourceEventId: v.string(),
        sourceAttachmentId: v.string(),
        driverId: v.string(),
        externalRef: v.optional(v.string()),
        filename: v.string(),
        mediaType: v.string(),
        kind: artifactKind,
        size: v.number(),
        sha256: v.string(),
        state: artifactState,
        failureCode: v.optional(v.string()),
    },
    returns: artifactDoc,
    handler: async (ctx, args) => {
        validateDriverId(args.driverId);
        validateExternalRef(args.externalRef);
        if (args.state === "ready" && !args.externalRef) {
            throw new Error("Ready artifacts require externalRef");
        }
        const account = await ctx.db.get(args.accountId);
        const agent = await ctx.db.get(args.agentId);
        if (!account || !agent || agent.accountId !== args.accountId) {
            throw new Error("Artifact account or agent scope is invalid");
        }
        const existing = await ctx.db
            .query("artifacts")
            .withIndex("by_accountId_and_artifactId", (q) =>
                q.eq("accountId", args.accountId).eq("artifactId", args.artifactId),
            )
            .unique();
        if (existing) {
            if (
                existing.agentId !== args.agentId
                || existing.conversationKey !== args.conversationKey
                || existing.sourceEventId !== args.sourceEventId
                || existing.sourceAttachmentId !== args.sourceAttachmentId
                || existing.filename !== args.filename
                || existing.mediaType !== args.mediaType
                || existing.kind !== args.kind
                || existing.size !== args.size
                || existing.sha256 !== args.sha256
            ) {
                throw new Error("Artifact idempotency key conflicts with an existing record");
            }

            return existing;
        }

        const now = Date.now();
        const id = await ctx.db.insert("artifacts", {
            ...args,
            createdAt: now,
            updatedAt: now,
            deletedAt: args.state === "deleted" ? now : undefined,
        });
        const created = await ctx.db.get(id);
        if (!created) throw new Error("Failed to read created artifact");

        return created;
    },
});

/** Updates mutable driver state after enforcing tenant and conversation scope. */
export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        conversationKey: v.string(),
        artifactId: v.string(),
        state: v.optional(artifactState),
        driverId: v.optional(v.string()),
        externalRef: v.optional(v.union(v.string(), v.null())),
        failureCode: v.optional(v.union(v.string(), v.null())),
    },
    returns: v.union(artifactDoc, v.null()),
    handler: async (ctx, args) => {
        const doc = await ctx.db
            .query("artifacts")
            .withIndex("by_accountId_and_artifactId", (q) =>
                q.eq("accountId", args.accountId).eq("artifactId", args.artifactId),
            )
            .unique();
        if (!doc || doc.conversationKey !== args.conversationKey) return null;
        if (args.driverId !== undefined) validateDriverId(args.driverId);
        const externalRef = args.externalRef === undefined ? doc.externalRef : args.externalRef ?? undefined;
        validateExternalRef(externalRef);
        const state = args.state ?? doc.state;
        assertStateTransition(doc.state, state);
        if (state === "ready" && !externalRef) {
            throw new Error("Ready artifacts require externalRef");
        }
        const now = Date.now();
        await ctx.db.patch(doc._id, {
            ...(args.state !== undefined ? { state: args.state } : {}),
            ...(args.driverId !== undefined ? { driverId: args.driverId } : {}),
            ...(args.externalRef !== undefined ? { externalRef: args.externalRef ?? undefined } : {}),
            ...(args.failureCode !== undefined ? { failureCode: args.failureCode ?? undefined } : {}),
            ...(args.state === "deleted"
                ? { deletedAt: now }
                : args.state !== undefined ? { deletedAt: undefined } : {}),
            updatedAt: now,
        });
        const updated = await ctx.db.get(doc._id);

        return updated;
    },
});

/** Soft-deletes an artifact and removes its durable driver reference. */
export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        conversationKey: v.string(),
        artifactId: v.string(),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
        const doc = await ctx.db
            .query("artifacts")
            .withIndex("by_accountId_and_artifactId", (q) =>
                q.eq("accountId", args.accountId).eq("artifactId", args.artifactId),
            )
            .unique();
        if (!doc || doc.conversationKey !== args.conversationKey) return false;
        const now = Date.now();
        await ctx.db.patch(doc._id, {
            state: "deleted",
            externalRef: undefined,
            deletedAt: now,
            updatedAt: now,
        });

        return true;
    },
});

/** Permanently removes one bounded batch of artifact control records for an account. */
export const removeAllForAccount = internalMutation({
    args: { accountId: v.id("accounts") },
    returns: v.number(),
    handler: async (ctx, args) => {
        const docs = await ctx.db
            .query("artifacts")
            .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
            .take(500);
        for (const doc of docs) {
            await ctx.db.delete(doc._id);
        }

        return docs.length;
    },
});
