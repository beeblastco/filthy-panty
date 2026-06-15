/**
 * Cron job CRUD scoped to an account. Mirrors filthy-panty's
 * functions/_shared/cron-jobs.ts so the SaaS dashboard can drive the same
 * lifecycle through Convex live queries. The AWS EventBridge Scheduler
 * names are stored here for visibility; the Lambda invokes EBS.
 */

import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { authKit } from "./auth";
import { getActiveOrgForUser } from "./model/ownership/org";
import { cronJobRunsFields, cronJobsFields } from "./schema";

const cronJobDoc = v.object({
    ...cronJobsFields,
    _id: v.id("cronJobs"),
    _creationTime: v.number(),
});

const cronJobRunDoc = v.object({
    ...cronJobRunsFields,
    _id: v.id("cronJobRuns"),
    _creationTime: v.number(),
});

const cronJobStatusValidator = v.union(v.literal("active"), v.literal("paused"));
const optionalCronJobStringValidator = v.optional(v.string());
const clearableCronJobStringValidator = v.optional(v.union(v.string(), v.null()));

const cronJobLastStatusValidator = v.union(
    v.literal("started"),
    v.literal("completed"),
    v.literal("failed"),
);

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

async function getOwned(ctx: Ctx, accountId: Id<"accounts">, cronJobId: Id<"cronJobs">) {
    const cronJob = await ctx.db.get(cronJobId);
    return cronJob && cronJob.accountId === accountId ? cronJob : null;
}

/**
 * Public query: lists cron jobs for the caller's active org. Used by the
 * cron-jobs dashboard page for live updates.
 */
export const listForActiveOrg = query({
    args: {},
    returns: v.array(cronJobDoc),
    handler: async (ctx) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .unique();
        if (!user) return [];

        const org = await getActiveOrgForUser(ctx, user._id);
        if (!org) return [];

        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
            .unique();
        if (!account) return [];

        return await ctx.db
            .query("cronJobs")
            .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
            .collect();
    },
});

export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
    },
    returns: v.union(cronJobDoc, v.null()),
    handler: (ctx, { accountId, cronJobId }) => getOwned(ctx, accountId, cronJobId),
});

export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(cronJobDoc),
    handler: (ctx, { accountId }) =>
        ctx.db
            .query("cronJobs")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect(),
});

export const listByStatus = internalQuery({
    args: {
        accountId: v.id("accounts"),
        status: cronJobStatusValidator,
    },
    returns: v.array(cronJobDoc),
    handler: (ctx, { accountId, status }) =>
        ctx.db
            .query("cronJobs")
            .withIndex("by_accountId_and_status", (q) =>
                q.eq("accountId", accountId).eq("status", status),
            )
            .collect(),
});

export const getBySchedulerName = internalQuery({
    args: { schedulerName: v.string() },
    returns: v.union(cronJobDoc, v.null()),
    handler: async (ctx, { schedulerName }) => {
        const cronJob = await ctx.db
            .query("cronJobs")
            .withIndex("by_schedulerName", (q) => q.eq("schedulerName", schedulerName))
            .unique();
        return cronJob ?? null;
    },
});

export const create = internalMutation({
    args: {
        accountId: v.id("accounts"),
        name: v.string(),
        description: optionalCronJobStringValidator,
        agentId: v.id("agents"),
        prompt: v.string(),
        conversationKey: optionalCronJobStringValidator,
        scheduleExpression: v.string(),
        timezone: optionalCronJobStringValidator,
        status: v.optional(cronJobStatusValidator),
        schedulerName: v.string(),
        schedulerGroupName: v.string(),
    },
    returns: v.id("cronJobs"),
    handler: async (ctx, args) => {
        const agent = await ctx.db.get(args.agentId);
        if (!agent || agent.accountId !== args.accountId) {
            throw new Error("Agent does not belong to the supplied accountId");
        }

        const now = Date.now();
        return ctx.db.insert("cronJobs", {
            ...args,
            status: args.status ?? "active",
            lastInvokedAt: undefined,
            lastStatus: undefined,
            lastError: undefined,
            createdAt: now,
            updatedAt: now,
        });
    },
});

export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
        name: v.optional(v.string()),
        description: clearableCronJobStringValidator,
        agentId: v.optional(v.id("agents")),
        prompt: v.optional(v.string()),
        conversationKey: clearableCronJobStringValidator,
        scheduleExpression: v.optional(v.string()),
        timezone: clearableCronJobStringValidator,
        status: v.optional(cronJobStatusValidator),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, cronJobId, agentId, ...patch } = args;

        const cronJob = await getOwned(ctx, accountId, cronJobId);
        if (!cronJob) {
            throw new Error("Cron job does not belong to the supplied accountId");
        }

        if (agentId !== undefined) {
            const agent = await ctx.db.get(agentId);
            if (!agent || agent.accountId !== accountId) {
                throw new Error("Agent does not belong to the supplied accountId");
            }
        }

        const defined = Object.fromEntries(
            Object.entries({ ...patch, agentId })
                .filter(([, v]) => v !== undefined)
                .map(([key, value]) => [key, value === null ? undefined : value]),
        );

        await ctx.db.patch(cronJobId, { ...defined, updatedAt: Date.now() });
        return null;
    },
});

/**
 * Records the result of an invocation. Status transitions:
 * undefined -> started -> completed | failed.
 */
export const recordInvocation = internalMutation({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
        lastStatus: cronJobLastStatusValidator,
        lastError: v.optional(v.string()),
        lastInvokedAt: v.optional(v.number()),
    },
    returns: v.null(),
    handler: async (ctx, { accountId, cronJobId, lastStatus, lastError, lastInvokedAt }) => {
        const cronJob = await getOwned(ctx, accountId, cronJobId);
        if (!cronJob) {
            throw new Error("Cron job does not belong to the supplied accountId");
        }

        await ctx.db.patch(cronJobId, {
            lastStatus,
            lastError,
            lastInvokedAt: lastInvokedAt ?? Date.now(),
            updatedAt: Date.now(),
        });
        return null;
    },
});

/** Creates a cron job run history row when EventBridge invokes a schedule. */
export const createRun = internalMutation({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
        eventId: v.string(),
        conversationKey: v.string(),
    },
    returns: v.id("cronJobRuns"),
    handler: async (ctx, args) => {
        const cronJob = await getOwned(ctx, args.accountId, args.cronJobId);
        if (!cronJob) {
            throw new Error("Cron job does not belong to the supplied accountId");
        }

        return await ctx.db.insert("cronJobRuns", {
            ...args,
            status: "started",
            startedAt: Date.now(),
        });
    },
});

/** Marks a cron job run complete and stores the final model result. */
export const completeRun = internalMutation({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
        runId: v.id("cronJobRuns"),
        result: v.any(),
    },
    returns: v.null(),
    handler: async (ctx, { accountId, cronJobId, runId, result }) => {
        const run = await ctx.db.get(runId);
        if (!run || run.accountId !== accountId || run.cronJobId !== cronJobId) {
            throw new Error("Cron job run does not belong to the supplied accountId and cronJobId");
        }

        await ctx.db.patch(runId, {
            status: "completed",
            result,
            completedAt: Date.now(),
        });

        return null;
    },
});

/** Marks a cron job run failed and stores the error. */
export const failRun = internalMutation({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
        runId: v.id("cronJobRuns"),
        error: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, { accountId, cronJobId, runId, error }) => {
        const run = await ctx.db.get(runId);
        if (!run || run.accountId !== accountId || run.cronJobId !== cronJobId) {
            throw new Error("Cron job run does not belong to the supplied accountId and cronJobId");
        }

        await ctx.db.patch(runId, {
            status: "failed",
            error,
            completedAt: Date.now(),
        });

        return null;
    },
});

/** Lists recent cron job runs newest-first for account-management APIs. */
export const listRuns = internalQuery({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
        limit: v.optional(v.number()),
    },
    returns: v.array(cronJobRunDoc),
    handler: async (ctx, { accountId, cronJobId, limit }) => {
        const cronJob = await getOwned(ctx, accountId, cronJobId);
        if (!cronJob) return [];

        return await ctx.db
            .query("cronJobRuns")
            .withIndex("by_accountId_and_cronJobId_and_startedAt", (q) =>
                q.eq("accountId", accountId).eq("cronJobId", cronJobId)
            )
            .order("desc")
            .take(limit ?? 20);
    },
});

export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
    },
    returns: v.null(),
    handler: async (ctx, { accountId, cronJobId }) => {
        const cronJob = await getOwned(ctx, accountId, cronJobId);
        if (cronJob) await ctx.db.delete(cronJobId);
        return null;
    },
});
