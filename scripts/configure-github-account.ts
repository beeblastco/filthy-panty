/**
 * CI configuration helper for the default GitHub account.
 * Creates or updates account config for GitHub App integration.
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
const githubAppId = requireScriptEnv("GITHUB_APP_ID");
const githubPrivateKey = requireScriptEnv("GITHUB_PRIVATE_KEY");
const githubWebhookSecret = requireScriptEnv("GITHUB_WEBHOOK_SECRET");
const allowedRepos = parseAllowedRepos(requireScriptEnv("GITHUB_ALLOWED_REPOS"));
const username = process.env.GITHUB_ACCOUNT_USERNAME?.trim();
const description = process.env.GITHUB_ACCOUNT_DESCRIPTION?.trim();

const account = await upsertGitHubAccount();
const webhookUrl = `${harnessProcessingUrl}/webhooks/${encodeURIComponent(account.accountId)}/github`;

console.log(`Configured GitHub account ${account.accountId}`);
console.log(`Register this webhook URL in your GitHub App: ${webhookUrl}`);

interface PublicAccount {
    accountId: string;
    username: string;
}

async function upsertGitHubAccount(): Promise<PublicAccount> {
    const existing = await findExistingAccount();
    const config = {
        channels: {
            github: {
                appId: githubAppId,
                privateKey: githubPrivateKey,
                webhookSecret: githubWebhookSecret,
                allowedRepos,
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

function parseAllowedRepos(raw: string): string[] {
    const repos = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    if (repos.length === 0) {
        throw new Error("GITHUB_ALLOWED_REPOS must contain at least one repository in owner/repo format");
    }

    return repos;
}