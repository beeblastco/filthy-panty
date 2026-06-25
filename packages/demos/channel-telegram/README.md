# Telegram Channel

Run `bun install`, `bun run dev`, then `bun run register` to register the generated webhook URL with Telegram.

This demo also includes a developer-owned remote artifact driver. Set one shared `ARTIFACT_DRIVER_SIGNING_SECRET`, expose `bun run driver` through public HTTPS, and configure:

```dotenv
ARTIFACT_DRIVER_ENDPOINT=https://storage.example.com/filthy-panty/artifacts
ARTIFACT_DRIVER_PUBLIC_BASE_URL=https://storage.example.com
ARTIFACT_DRIVER_SIGNING_SECRET=replace-with-a-random-secret
```

`artifact-driver.ts` implements signed `store`, `resolve`, and required compensating `delete`, verifies transferred size/checksum, and returns signed five-minute read grants. Its local disk and in-memory nonce claim are for a single-process demo. Production drivers must use durable object storage and atomically claim nonces in a shared database or cache so replay protection works across instances and restarts.

This example enables Telegram's supported media paths:

- Incoming photos, documents, video, animation, voice, and audio are ingested automatically. There is no attachment command.
- The `artifact` tool can inspect metadata/text and rehydrate explicitly model-supported binary MIME types without returning storage URLs or persisting bytes.
- The agent has a writable `outbox` workspace and may create a file there before sending it through `channel_message`.
- `mediaMaxMb: 20` bounds each inbound download. Invalid or unavailable files do not discard accompanying text.

After registration, exercise the flow with these cases:

1. Send a message with a small text or JSON document, then ask about it in a later message.
2. Send a photo with a caption and confirm the caption still reaches the agent. This demo keeps the secure descriptor-only model default; it does not declare native image input support for MiniMax-M3.
3. Ask the agent to create `summary.txt` in `outbox` and send it back with a caption.
4. Send an unsupported, malformed, or oversized file and confirm the text portion is still handled with an attachment-unavailable descriptor.

Complex artifacts are materialized from artifact storage into `outbox/.artifacts/<artifactId>/<filename>`. The copy is non-executable and is not unpacked automatically; artifact storage remains the source of truth.
