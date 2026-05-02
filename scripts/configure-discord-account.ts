/**
 * CI configuration helper for the default Discord account.
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
const discordBotToken = requireScriptEnv("DISCORD_BOT_TOKEN");
const discordPublicKey = requireScriptEnv("DISCORD_PUBLIC_KEY");
const allowedGuildIds = parseAllowedGuildIds(requireScriptEnv("DISCORD_ALLOWED_GUILD_IDS"));
const username = process.env.DISCORD_ACCOUNT_USERNAME?.trim();
const description = process.env.DISCORD_ACCOUNT_DESCRIPTION?.trim();

const account = await upsertDiscordAccount();
const webhookUrl = `${harnessProcessingUrl}/webhooks/${encodeURIComponent(account.accountId)}/discord`;

console.log(`Configured Discord account ${account.accountId}`);
console.log(`Register this URL in your Discord application: ${webhookUrl}`);

interface PublicAccount {
    accountId: string;
    username: string;
}

async function upsertDiscordAccount(): Promise<PublicAccount> {
    const existing = await findExistingAccount();
    const config = {
        channels: {
            discord: {
                botToken: discordBotToken,
                publicKey: discordPublicKey,
                allowedGuildIds,
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

function parseAllowedGuildIds(raw: string): string[] {
    const ids = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    if (ids.length === 0) {
        throw new Error("DISCORD_ALLOWED_GUILD_IDS must contain at least one Discord guild id");
    }

    return ids;
}