/**
 * Artifact control-record validation and DynamoDB persistence tests.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  createArtifactId,
  normalizeCreateArtifactInput,
  normalizeUpdateArtifactInput,
} from "../functions/_shared/storage/artifacts.ts";
import { dynamoArtifactStore } from "../functions/_shared/storage/dynamo/artifacts.ts";
import { dynamo } from "../functions/_shared/storage/dynamo/client.ts";

const originalSend = dynamo.send;
let records: Map<string, Record<string, AttributeValue>>;
let lastConversationQuery: QueryCommand | undefined;

const input = {
  agentId: "agent_1",
  conversationKey: "telegram:chat:42",
  sourceEventId: "update_100",
  sourceAttachmentId: "photo_2",
  driverId: "customer-storage",
  externalRef: "tenant/opaque/abc123",
  filename: "photo.jpg",
  mediaType: "image/jpeg",
  kind: "image" as const,
  size: 42,
  sha256: "a".repeat(64),
  state: "ready" as const,
};

beforeEach(() => {
  process.env.ARTIFACTS_TABLE_NAME = "artifacts";
  records = new Map();
  lastConversationQuery = undefined;
  dynamo.send = createInMemorySend(records) as never;
});

afterEach(() => {
  dynamo.send = originalSend;
  delete process.env.ARTIFACTS_TABLE_NAME;
});

describe("artifact validation", () => {
  it("derives a stable ID from the complete source identity", () => {
    expect(createArtifactId("acct_1", input)).toBe(createArtifactId("acct_1", input));
    expect(createArtifactId("acct_1", input)).not.toBe(createArtifactId("acct_1", {
      ...input,
      sourceAttachmentId: "photo_3",
    }));
  });

  it("rejects durable URLs and ready records without an opaque reference", () => {
    expect(() => normalizeCreateArtifactInput({
      ...input,
      externalRef: "https://storage.example/signed?secret=1",
    })).toThrow(/must be opaque and must not use a URI scheme/);
    expect(() => normalizeCreateArtifactInput({
      ...input,
      externalRef: "s3:bucket/key",
    })).toThrow(/URI scheme/);
    expect(() => normalizeCreateArtifactInput({
      ...input,
      externalRef: undefined,
    })).toThrow(/require externalRef/);
    expect(() => normalizeUpdateArtifactInput({ state: "ready", externalRef: null })).toThrow(/require externalRef/);
  });
});

describe("Dynamo artifact store", () => {
  it("is idempotent for duplicate source deliveries", async () => {
    const first = await dynamoArtifactStore.create("acct_1", input);
    const duplicate = await dynamoArtifactStore.create("acct_1", input);
    expect(duplicate).toEqual(first);
    expect(records.size).toBe(1);
  });

  it("rejects duplicate source identities with different immutable metadata", async () => {
    await dynamoArtifactStore.create("acct_1", input);
    await expect(dynamoArtifactStore.create("acct_1", {
      ...input,
      sha256: "b".repeat(64),
    })).rejects.toThrow(/idempotency key conflicts/);
  });

  it("enforces account and conversation scope on reads", async () => {
    const created = await dynamoArtifactStore.create("acct_1", input);
    expect(await dynamoArtifactStore.getById("acct_1", input.conversationKey, created.artifactId)).toEqual(created);
    expect(await dynamoArtifactStore.getById("acct_2", input.conversationKey, created.artifactId)).toBeNull();
    expect(await dynamoArtifactStore.getById("acct_1", "another-conversation", created.artifactId)).toBeNull();
  });

  it("lists only the requested conversation and soft-deletes references", async () => {
    const created = await dynamoArtifactStore.create("acct_1", input);
    await dynamoArtifactStore.create("acct_1", {
      ...input,
      conversationKey: "slack:channel:7",
      sourceEventId: "event_2",
    });
    expect((await dynamoArtifactStore.list("acct_1", input.conversationKey)).map((row) => row.artifactId)).toEqual([created.artifactId]);
    expect(lastConversationQuery?.input.ConsistentRead).toBeUndefined();

    expect(await dynamoArtifactStore.remove("acct_1", input.conversationKey, created.artifactId)).toBe(true);
    const deleted = await dynamoArtifactStore.getById("acct_1", input.conversationKey, created.artifactId);
    expect(deleted?.state).toBe("deleted");
    expect(deleted?.externalRef).toBeUndefined();
  });

  it("permanently removes all control records for one account", async () => {
    await dynamoArtifactStore.create("acct_1", input);
    await dynamoArtifactStore.create("acct_1", { ...input, sourceAttachmentId: "photo_3" });
    await dynamoArtifactStore.create("acct_2", input);
    expect(await dynamoArtifactStore.removeAllForAccount("acct_1")).toBe(2);
    expect([...records.values()].map((item) => item.accountId?.S)).toEqual(["acct_2"]);
  });

  it("fails account cleanup after bounded unprocessed-write retries", async () => {
    let batchAttempts = 0;
    dynamo.send = mock(async (command: QueryCommand | BatchWriteItemCommand) => {
      if (command instanceof QueryCommand) {
        return { Items: [{ accountId: { S: "acct_1" }, artifactId: { S: "art_1" } }] };
      }
      batchAttempts += 1;
      return { UnprocessedItems: { artifacts: command.input.RequestItems?.artifacts } };
    }) as never;

    await expect(dynamoArtifactStore.removeAllForAccount("acct_1"))
      .rejects.toThrow(/retained unprocessed DynamoDB writes/);
    expect(batchAttempts).toBe(5);
  });

  it("switches the owning driver and opaque reference together", async () => {
    const created = await dynamoArtifactStore.create("acct_1", input);
    const updated = await dynamoArtifactStore.update(
      "acct_1",
      input.conversationKey,
      created.artifactId,
      { driverId: "managed-ephemeral", externalRef: "staging/fallback/42" },
    );
    expect(updated?.driverId).toBe("managed-ephemeral");
    expect(updated?.externalRef).toBe("staging/fallback/42");
    expect(() => normalizeUpdateArtifactInput({ driverId: "" })).toThrow(/driverId/);
  });

  it("does not resurrect terminal artifacts", async () => {
    const created = await dynamoArtifactStore.create("acct_1", input);
    await dynamoArtifactStore.remove("acct_1", input.conversationKey, created.artifactId);
    await expect(dynamoArtifactStore.update("acct_1", input.conversationKey, created.artifactId, {
      state: "ready",
      externalRef: "tenant/new/ref",
    })).rejects.toThrow(/Invalid artifact state transition/);
  });
});

function createInMemorySend(table: Map<string, Record<string, AttributeValue>>) {
  const keyOf = (attrs: Record<string, AttributeValue>): string =>
    `${attrs.accountId?.S ?? ""}|${attrs.artifactId?.S ?? ""}`;
  const attrs = (value: unknown): Record<string, AttributeValue> =>
    (value ?? {}) as Record<string, AttributeValue>;

  return mock(async (command: PutItemCommand | GetItemCommand | QueryCommand | UpdateItemCommand | BatchWriteItemCommand) => {
    if (command instanceof PutItemCommand) {
      const item = attrs(command.input.Item);
      const key = keyOf(item);
      if (table.has(key)) {
        throw new ConditionalCheckFailedException({ $metadata: {}, message: "duplicate" });
      }
      table.set(key, item);
      return {};
    }
    if (command instanceof GetItemCommand) {
      return { Item: table.get(keyOf(attrs(command.input.Key))) };
    }
    if (command instanceof QueryCommand) {
      if (command.input.IndexName === "ConversationIndex") lastConversationQuery = command;
      const values = attrs(command.input.ExpressionAttributeValues);
      return {
        Items: [...table.values()].filter((item) =>
          item.accountId?.S === values[":accountId"]?.S
          && (values[":conversationKey"] === undefined || item.conversationKey?.S === values[":conversationKey"]?.S),
        ),
      };
    }
    if (command instanceof BatchWriteItemCommand) {
      for (const request of command.input.RequestItems?.artifacts ?? []) {
        if (request.DeleteRequest?.Key) table.delete(keyOf(attrs(request.DeleteRequest.Key)));
      }
      return {};
    }

    const key = keyOf(attrs(command.input.Key));
    const item = table.get(key);
    const values = attrs(command.input.ExpressionAttributeValues);
    if (!item || item.conversationKey?.S !== values[":conversationKey"]?.S
      || item.state?.S !== values[":expectedState"]?.S) {
      throw new ConditionalCheckFailedException({ $metadata: {}, message: "missing" });
    }
    item.updatedAt = values[":updatedAt"]!;
    if (values[":state"]) item.state = values[":state"]!;
    if (values[":driverId"]) item.driverId = values[":driverId"]!;
    if (values[":deletedAt"]) item.deletedAt = values[":deletedAt"]!;
    if (values[":externalRef"]) item.externalRef = values[":externalRef"]!;
    if (values[":failureCode"]) item.failureCode = values[":failureCode"]!;
    if (command.input.UpdateExpression?.includes("REMOVE")) {
      const removeClause = command.input.UpdateExpression.split("REMOVE ")[1] ?? "";
      if (removeClause.includes("externalRef")) delete item.externalRef;
      if (removeClause.includes("failureCode")) delete item.failureCode;
      if (removeClause.includes("deletedAt")) delete item.deletedAt;
    }
    return { Attributes: item };
  });
}
