# Agent

This repository is a template for agentic AI applications using Architecture A: Step Functions Express + Lambda tools, deployed with SST.

Key rules:

- Keep the constants, naming pattern, and tag conventions in `sst.config.ts` aligned with the infra repo.
- Each Lambda function lives in its own folder under `functions/` with a `bootstrap.ts` entry point for the Bun custom runtime.
- Default runtime is Bun on Lambda `provided.al2023` with ARM64 binaries built by `scripts/build.ts`.
- The agentic loop runs entirely inside a Step Functions Express workflow. Bedrock and DynamoDB are called via SDK integrations (no Lambda). Only tool execution uses Lambda.
- To add a new tool: create `functions/tool-<name>/`, add the Lambda to `sst.config.ts`, register it in `toolArnMapping` and `toolLambdaArns`, and define its spec in `functions/_shared/tools.ts`.
- Tool Lambdas receive `{ toolUseId, input, context }` and must return `{ toolUseId, content, status }`.
- Shared code goes in `functions/_shared/`. Do not duplicate utilities across function folders.
- Use `bun run build` to compile all functions, then `bun run deploy` to deploy.
- CI/CD runs automatically on push/PR via GitHub Actions. Use `gh run list` and `gh run view` to monitor pipeline status.
- To add a new communication channel (e.g. Slack, WhatsApp): create `functions/_shared/<channel>-channel.ts` implementing the `ChannelAdapter` interface from `functions/_shared/channels.ts` (authenticate, parse, actions), then register it in the `channels` array in `functions/webhook-receiver/handler.ts`. Do not put channel-specific logic in the webhook handler itself.
- To add a new bot command: add an entry to the `commands` array in `functions/_shared/commands.ts` with aliases, description, and an execute function. Commands receive a `CommandContext` with a channel-agnostic `ChannelActions` interface — do not import channel-specific modules from commands.
- Reply formatting uses `markdownToHtml()` from `functions/_shared/telegram.ts` for Telegram. New channels should implement their own formatting in their channel module if needed.
