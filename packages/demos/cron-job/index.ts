/**
 * Prints the synced cron job status and recent run results.
 *
 * Cron jobs are declared in filthypanty/agents.ts and synced by `bun run dev`.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

const cronJobName = "one-minute-cron-test";
const cronJobId = (api.cronJobs as Record<string, string | undefined>)[cronJobName];

const client = new FilthyPantyClient({
  apiKey: process.env.FILTHY_PANTY_API_KEY!,
  host: process.env.FILTHY_PANTY_HOST!,
});

const cronJob = cronJobId
  ? await client.getCronJob(cronJobId)
  : (await client.listCronJobs()).find((job) => job.name === cronJobName) ?? null;

if (!cronJob) {
  throw new Error(`Cron job not found: ${cronJobName}. Run \`bun run dev\` first.`);
}

const runs = await client.listCronJobRuns(cronJob.cronJobId, { limit: 10 });

console.log(JSON.stringify({
  cronJob: {
    cronJobId: cronJob.cronJobId,
    name: cronJob.name,
    status: cronJob.status,
    lastStatus: cronJob.lastStatus ?? null,
    lastInvokedAt: cronJob.lastInvokedAt ?? null,
    lastError: cronJob.lastError ?? null,
  },
  runs: runs.map((run) => ({
    runId: run.runId,
    eventId: run.eventId,
    conversationKey: run.conversationKey,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? null,
    result: run.result ?? null,
    error: run.error ?? null,
  })),
}, null, 2));
