# filthy-panty

Agentic AI chatbot on AWS — Step Functions Express + Bedrock + Telegram.

## Prerequisites

- [Bun](https://bun.sh)
- [SST v4](https://sst.dev)
- AWS credentials configured
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

### 1. Install dependencies

```sh
bun install
```

### 2. Set secrets

```sh
bunx sst secret set TelegramBotToken "<your-bot-token>"
bunx sst secret set TelegramWebhookSecret "<a-random-string>"
bunx sst secret set AllowedChatIds "123456,789012"
```

- **TelegramBotToken** — the token BotFather gave you.
- **TelegramWebhookSecret** — any random string (1-256 chars). Telegram sends it in every webhook request so we can verify the request is authentic.
- **AllowedChatIds** — comma-separated Telegram chat IDs that are allowed to talk to the bot. Get your chat ID by messaging [@userinfobot](https://t.me/userinfobot).

### 3. Build and deploy

```sh
bun run build
bun run deploy
```

SST will output the `webhookReceiverUrl` at the end.

### 4. Register the Telegram webhook

```sh
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<webhookReceiverUrl>&secret_token=<your-secret>"
```

Replace `<TOKEN>`, `<webhookReceiverUrl>`, and `<your-secret>` with your values.

## Adding tools

1. Create `functions/tool-<name>/` with a `bootstrap.ts` entry point.
2. Add the Lambda to `sst.config.ts`, register its ARN in `toolArnMapping` and `toolLambdaArns`.
3. Define the tool spec in `functions/_shared/tools.ts`.

See `CLAUDE.md` for full conventions.
