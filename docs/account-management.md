# Account Management

Accounts are the configuration boundary for the harness. Each account has:

- `accountId`: generated stable id used in webhook URLs.
- `username`: required human-readable account name.
- `description`: optional purpose/usage note.
- `accountSecret`: one-time API secret returned on create or rotation.
- `config`: encrypted account configuration used by `harness-processing`.

Account API secrets are stored as hashes. Provider tokens and webhook secrets must be usable at runtime, so they are stored inside the encrypted account config payload.

## Create Account

`POST /accounts` on the `account-manage` Function URL is public and IP-rate-limited.

```bash
curl -X POST "$ACCOUNT_MANAGE_URL/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "company-a",
    "description": "Customer support agent for Company A"
  }'
```

Response:

```json
{
  "account": {
    "accountId": "acct_...",
    "username": "company-a",
    "description": "Customer support agent for Company A",
    "status": "active",
    "config": {},
    "createdAt": "2026-05-01T00:00:00.000Z",
    "updatedAt": "2026-05-01T00:00:00.000Z"
  },
  "accountSecret": "fp_acct_..."
}
```

Store `accountSecret` securely. It is not recoverable; rotate it if lost.

If `config` is omitted, the stored config is `{}`. Runtime requests will fail until `config.model.provider`, `config.model.modelId`, and the matching `config.provider.<provider>.apiKey` are configured.

## Manage Own Account

All self-management requests use:

```http
Authorization: Bearer <accountSecret>
```

Endpoints:

- `GET /accounts/me`
- `PATCH /accounts/me`
- `POST /accounts/me/rotate-secret`
- `DELETE /accounts/me`

Patch account metadata or config:

```bash
curl -X PATCH "$ACCOUNT_MANAGE_URL/accounts/me" \
  -H "Authorization: Bearer $ACCOUNT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated account purpose",
    "config": {
      "memoryNamespace": "support",
      "channels": {
        "telegram": {
          "botToken": "...",
          "webhookSecret": "...",
          "allowedChatIds": [123456789]
        }
      }
    }
  }'
```

Patch behavior is a deep merge. Redacted secret placeholders returned by reads (`********`) preserve the existing stored secret if sent back. Set a config field to `null` to delete it, for example `"memoryNamespace": null`.

## Admin Account

`AdminAccountSecret` is an SST secret. Requests using it can manage all accounts:

- `GET /accounts`
- `GET /accounts/{accountId}`
- `PATCH /accounts/{accountId}`
- `POST /accounts/{accountId}/rotate-secret`
- `DELETE /accounts/{accountId}`

The admin account is virtual; it is not a normal account record.

## Delete Account

`DELETE /accounts/me` and admin `DELETE /accounts/{accountId}` remove the account and cascade cleanup for account-scoped runtime data:

- direct and channel conversation rows
- processed event dedupe rows and conversation leases
- async direct API status rows
- current account filesystem, memory, and task objects

Response:

```json
{
  "deleted": true,
  "cleanup": {
    "conversationsDeleted": 12,
    "processedEventsDeleted": 14,
    "asyncResultsDeleted": 2,
    "filesystemObjectsDeleted": 8
  }
}
```

## Account Config

Top-level runtime config:

```json
{
  "provider": {
    "google": {
      "apiKey": "..."
    },
    "openai": {
      "apiKey": "..."
    },
    "bedrock": {
      "region": "us-east-1",
      "apiKey": "..."
    },
    "gateway": {
      "apiKey": "..."
    }
  },
  "model": {
    "provider": "google",
    "modelId": "gemini-3-flash",
    "temperature": 0.2,
    "maxOutputTokens": 16000,
    "options": {
      "google": {
        "thinkingConfig": {
          "thinkingLevel": "high"
        }
      }
    }
  },
  "maxAgentIterations": 20,
  "slidingContextWindow": 20,
  "systemPrompt": "Optional account-specific system prompt.",
  "memoryNamespace": "support",
  "tools": {},
  "channels": {}
}
```

`provider` config stores constructor settings for the selected AI SDK provider. The selected provider entry must exist and include `apiKey`.

- `google`: passed to `createGoogleGenerativeAI(...)`.
- `openai`: passed to `createOpenAI(...)`.
- `bedrock`: passed to `createAmazonBedrock(...)`.
- `gateway`: passed to `createGateway(...)`.

Secret-like fields such as `apiKey`, `secret`, `token`, and `privateKey` are encrypted at rest and redacted from account reads.

`model` config controls the Vercel AI SDK `streamText` call:

- `provider`: selects the provider constructor: `google`, `openai`, `bedrock`, or `gateway`.
- `modelId`: provider model id.
- `options`: passed to `streamText` as `providerOptions`.
- Other fields under `model`, such as `temperature`, `maxOutputTokens`, `topP`, `headers`, or `timeout`, are passed through as normal `streamText` settings. Harness-owned fields such as messages, system prompt assembly, tools, callbacks, and stop conditions remain controlled by the runtime.

`memoryNamespace` controls whether memory/files are per conversation or shared across conversations in the same account. See [Memory and Session](memory-and-session.md) for the visual model.

Tool config:

```json
{
  "tools": {
    "filesystem": { "enabled": true },
    "tasks": { "enabled": true },
    "tavilySearch": {
      "enabled": true,
      "searchDepth": "advanced",
      "includeAnswer": true,
      "maxResults": 5,
      "topic": "general"
    },
    "tavilyExtract": {
      "enabled": true,
      "extractDepth": "advanced",
      "format": "markdown"
    },
    "googleSearch": {
      "enabled": true,
      "searchTypes": {
        "webSearch": {}
      }
    }
  }
}
```

Tools are opt-in. If `config.tools` is omitted, the agent runs without custom or provider-defined tools. Listed tools are enabled by default; set `"enabled": false` to disable a listed tool without deleting its config. Unknown tool names are rejected during account create/update.

Supported tool names:

- `filesystem`: S3-backed persistent virtual filesystem.
- `tasks`: task-list helper backed by the virtual filesystem.
- `tavilySearch`: Tavily web search using the global `TAVILY_API_KEY`.
- `tavilyExtract`: Tavily page extraction using the global `TAVILY_API_KEY`.
- `googleSearch`: Google provider-defined search via `google.tools.googleSearch()`.

Channel config:

```json
{
  "channels": {
    "telegram": {
      "botToken": "...",
      "webhookSecret": "...",
      "allowedChatIds": [123456789],
      "reactionEmoji": "👀"
    },
    "github": {
      "webhookSecret": "...",
      "appId": "...",
      "privateKey": "...",
      "allowedRepos": ["owner/repo"]
    },
    "slack": {
      "botToken": "...",
      "signingSecret": "...",
      "allowedChannelIds": ["C123"]
    },
    "discord": {
      "botToken": "...",
      "publicKey": "...",
      "allowedGuildIds": ["123"]
    }
  }
}
```

Provider webhook URLs must include the account id:

```text
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/telegram
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/github
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/slack
{HARNESS_PROCESSING_URL}/webhooks/{accountId}/discord
```

Customers only interact with the provider bot/app. They do not receive account secrets.

CI/CD configures the default Telegram account by running `bun run scripts/configure-telegram-account.ts` after deploy. The script upserts `telegram-default` by username, stores Telegram credentials in encrypted account config, and registers Telegram to `/webhooks/{accountId}/telegram`.
