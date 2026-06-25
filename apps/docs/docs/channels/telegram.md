# Telegram

Telegram integration allows your agent to interact with users via Telegram bots.

## Configuration

To enable Telegram, include the following in your agent configuration:

```json
{
  "channels": {
    "telegram": {
      "botToken": "your-bot-token",
      "webhookSecret": "your-webhook-secret",
      "allowedChatIds": [123456789, 987654321],
      "reactionEmoji": "👀",
      "streaming": { "mode": "edit" },
      "actions": { "reactions": true, "attachments": true },
      "mediaMaxMb": 20
    }
  }
}
```

- `botToken`: Provided by BotFather.
- `webhookSecret`: A secret string to verify incoming webhooks.
- `allowedChatIds`: An array of numeric chat IDs allowed to talk to the agent.
- `reactionEmoji` (optional): Emoji to use for reactions, defaults to "👀".
- `streaming` (optional): Live reply streaming. Telegram supports all modes — `edit` (edit one message in place), `progress` (tool-activity preview then final answer), `chunk` (one message per paragraph), or `off` (default). See [Reply Streaming](index.md#reply-streaming).
- `actions` (optional): Enables model-initiated reactions and/or native media sends. Sending media requires an attached workspace containing the file.
- `mediaMaxMb` (optional): Per-file and aggregate per-webhook inbound download budget from 1 to 20 MiB; defaults to 20 MiB. The aggregate bound limits Lambda memory during multi-attachment events.

Photos, documents, video, animation, voice, and audio are ingested automatically from authenticated updates. No command is required. Artifact storage remains authoritative; configured workspace materialization creates only an optional working copy.

Telegram delivers each album item as a separate webhook update. The current Lambda adapter processes those updates as separate agent turns; it does not claim durable media-group coalescing.
