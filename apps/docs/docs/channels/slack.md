# Slack

Slack integration allows your agent to interact with users via Slack.

## Configuration

To enable Slack, include the following in your agent configuration:

```json
{
  "channels": {
    "slack": {
      "botToken": "your-bot-token",
      "signingSecret": "your-signing-secret",
      "allowedChannelIds": ["channel-id-1"],
      "streaming": { "mode": "edit" },
      "actions": { "reactions": true, "attachments": true },
      "mediaMaxMb": 20
    }
  }
}
```

- `botToken`: Slack Bot User OAuth Token.
- `signingSecret`: Used to verify Slack requests.
- `allowedChannelIds` (optional): An array of strings representing allowed channel IDs.
- `streaming` (optional): Live reply streaming via `chat.update`. Supports `edit`, `progress`, `chunk`, or `off` (default). See [Reply Streaming](index.md#reply-streaming).
- `actions` (optional): Enables model-initiated reactions and/or Slack external-upload sends. Sending a file requires an attached workspace containing it.
- `mediaMaxMb` (optional): Per-file and aggregate per-event inbound download budget from 1 to 20 MiB; defaults to 20 MiB. The aggregate bound limits Lambda memory during multi-file events.

Files on supported `file_share` events are ingested automatically after Slack authentication. No command is required. Provider URLs are never persisted; configured artifact policy may create an integrity-checked workspace working copy from artifact storage.
