/**
 * CI configuration helper for the default Slack account.
 * Creates or updates account config, then registers the account-scoped webhook.
 */

import {
    isRecord,
    outputOrEnv,
    parseJson,
    requireScriptEnv,
    stripTrailingSlash,
} from "./utils.ts";

const accountManageUrl = stripTrailingSlash(outputOrEnv("ACCOUNT_MANAGE_URL", "accountManageUrl"));
const harnessProcessingUrl = stripTrailingSlash(outputOrEnv("HARNESS_PROCESSING_URL", "harnessProcessingUrl"));
const adminSecret = requireScriptEnv("ADMIN_ACCOUNT_SECRET");
const slackBotToken = requireScriptEnv("SLACK_BOT_TOKEN");
const slackSigningSecret = requireScriptEnv("SLACK_SIGNING_SECRET");
const allowedChannelIds = parseAllowedChannelIds(requireScriptEnv("SLACK_ALLOWED_CHANNEL_IDS"));
const username = process.env.SLACK_ACCOUNT_USERNAME?.trim();
const description = process.env.SLACK_ACCOUNT_DESCRIPTION?.trim();

const account = await upsertSlackAccount();
const webhookUrl = `${harnessProcessingUrl}/webhooks/${encodeURIComponent(account.accountId)}/slack`;

console.log(`Configured Slack account ${account.accountId}`);
console.log(`Register this URL in your Slack app's Event Subscriptions: ${webhookUrl}`);

interface PublicAccount {
    accountId: string;
    username: string;
}

async function upsertSlackAccount(): Promise<PublicAccount> {
    const existing = await findExistingAccount();
    const config = {
        channels: {
            slack: {
                botToken: slackBotToken,
                signingSecret: slackSigningSecret,
                allowedChannelIds,
            },
        },
    };

    if (existing) {
        const updated = await accountApi("PATCH", `/accounts/${encodeURIComponent(existing.accountId)}`, {
            username: username,
            description: description,
            config: config,
        });
        return parseAccountResponse(updated);
    }

    const created = await publicAccountApi("POST", "/accounts", {
        username: username,
        description: description,
        config: config,
    });
    return parseAccountResponse(created);
}

async function findExistingAccount(): Promise<PublicAccount | null> {
    const response = await accountApi("GET", "/accounts");
    if (!isRecord(response) || !Array.isArray(response.accounts)) {
        throw new Error("Account list response must include accounts array");
    }

    return response.accounts.find((entry): entry is PublicAccount =>
        isPublicAccount(entry) && entry.username === username,
    ) ?? null;
}

async function accountApi(method: string, path: string, body?: unknown): Promise<unknown> {
    return requestJson(`${accountManageUrl}${path}`, {
        method,
        headers: {
            "Authorization": `Bearer ${adminSecret}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

async function publicAccountApi(method: string, path: string, body: unknown): Promise<unknown> {
    return requestJson(`${accountManageUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(url, init);
    const bodyText = await response.text();
    if (!response.ok) {
        throw new Error(`${init.method ?? "GET"} ${url} failed: ${response.status} ${bodyText}`);
    }

    return bodyText ? parseJson(bodyText) : {};
}

function parseAccountResponse(value: unknown): PublicAccount {
    if (!isRecord(value) || !isPublicAccount(value.account)) {
        throw new Error("Account response must include account.accountId and account.username");
    }

    return value.account;
}

function isPublicAccount(value: unknown): value is PublicAccount {
    return isRecord(value) &&
        typeof value.accountId === "string" &&
        typeof value.username === "string";
}

function parseAllowedChannelIds(raw: string): string[] {
    const ids = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    if (ids.length === 0) {
        throw new Error("SLACK_ALLOWED_CHANNEL_IDS must contain at least one Slack channel id");
    }

    return ids;
}