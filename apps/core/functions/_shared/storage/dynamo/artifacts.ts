/**
 * DynamoDB artifact control-record persistence.
 * The table stores metadata and opaque driver references, never artifact bytes.
 */

import {
  BatchWriteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import { requireEnv } from "../../env.ts";
import {
  assertArtifactStateTransition,
  createArtifactId,
  normalizeCreateArtifactInput,
  normalizeUpdateArtifactInput,
  type ArtifactRecord,
} from "../artifacts.ts";
import type { ArtifactStore } from "../types.ts";
import { dynamo, isConditionalCheckFailed } from "./client.ts";

function artifactsTableName(): string {
  return requireEnv("ARTIFACTS_TABLE_NAME");
}

function recordToItem(record: ArtifactRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: record.accountId },
    artifactId: { S: record.artifactId },
    agentId: { S: record.agentId },
    conversationKey: { S: record.conversationKey },
    sourceEventId: { S: record.sourceEventId },
    sourceAttachmentId: { S: record.sourceAttachmentId },
    driverId: { S: record.driverId },
    ...(record.externalRef ? { externalRef: { S: record.externalRef } } : {}),
    filename: { S: record.filename },
    mediaType: { S: record.mediaType },
    kind: { S: record.kind },
    size: { N: String(record.size) },
    sha256: { S: record.sha256 },
    state: { S: record.state },
    ...(record.failureCode ? { failureCode: { S: record.failureCode } } : {}),
    createdAt: { S: record.createdAt },
    updatedAt: { S: record.updatedAt },
    ...(record.deletedAt ? { deletedAt: { S: record.deletedAt } } : {}),
  };
}

function itemToRecord(item: Record<string, AttributeValue>): ArtifactRecord | null {
  const accountId = item.accountId?.S;
  const artifactId = item.artifactId?.S;
  const agentId = item.agentId?.S;
  const conversationKey = item.conversationKey?.S;
  const sourceEventId = item.sourceEventId?.S;
  const sourceAttachmentId = item.sourceAttachmentId?.S;
  const driverId = item.driverId?.S;
  const filename = item.filename?.S;
  const mediaType = item.mediaType?.S;
  const kind = item.kind?.S;
  const size = item.size?.N === undefined ? undefined : Number(item.size.N);
  const sha256 = item.sha256?.S;
  const state = item.state?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  if (
    !accountId || !artifactId || !agentId || !conversationKey || !sourceEventId
    || !sourceAttachmentId || !driverId || !filename || !mediaType || !kind
    || size === undefined || !sha256 || !state || !createdAt || !updatedAt
  ) return null;
  if (!["image", "audio", "video", "document", "file"].includes(kind)) return null;
  if (!["pending", "ready", "failed", "expired", "deleted"].includes(state)) return null;
  return {
    accountId,
    artifactId,
    agentId,
    conversationKey,
    sourceEventId,
    sourceAttachmentId,
    driverId,
    ...(item.externalRef?.S ? { externalRef: item.externalRef.S } : {}),
    filename,
    mediaType,
    kind: kind as ArtifactRecord["kind"],
    size,
    sha256,
    state: state as ArtifactRecord["state"],
    ...(item.failureCode?.S ? { failureCode: item.failureCode.S } : {}),
    createdAt,
    updatedAt,
    ...(item.deletedAt?.S ? { deletedAt: item.deletedAt.S } : {}),
  };
}

function sameArtifact(record: ArtifactRecord, input: ReturnType<typeof normalizeCreateArtifactInput>): boolean {
  return record.agentId === input.agentId
    && record.conversationKey === input.conversationKey
    && record.sourceEventId === input.sourceEventId
    && record.sourceAttachmentId === input.sourceAttachmentId
    && record.filename === input.filename
    && record.mediaType === input.mediaType
    && record.kind === input.kind
    && record.size === input.size
    && record.sha256 === input.sha256;
}

export const dynamoArtifactStore: ArtifactStore = {
  async getById(accountId, conversationKey, artifactId) {
    const result = await dynamo.send(new GetItemCommand({
      TableName: artifactsTableName(),
      Key: { accountId: { S: accountId }, artifactId: { S: artifactId } },
      ConsistentRead: true,
    }));
    const record = result.Item ? itemToRecord(result.Item) : null;
    return record?.conversationKey === conversationKey ? record : null;
  },

  async list(accountId, conversationKey, requestedLimit = 100) {
    const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)));
    const records: ArtifactRecord[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await dynamo.send(new QueryCommand({
        TableName: artifactsTableName(),
        IndexName: "ConversationIndex",
        KeyConditionExpression: "accountId = :accountId AND conversationKey = :conversationKey",
        ExpressionAttributeValues: {
          ":accountId": { S: accountId },
          ":conversationKey": { S: conversationKey },
        },
        Limit: limit,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }));
      records.push(...(result.Items ?? []).map(itemToRecord).filter((record): record is ArtifactRecord => record !== null));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey && records.length < limit);
    return records.slice(0, limit);
  },

  async create(accountId, rawInput) {
    const input = normalizeCreateArtifactInput(rawInput);
    const artifactId = createArtifactId(accountId, input);
    const now = new Date().toISOString();
    const record: ArtifactRecord = {
      accountId,
      artifactId,
      ...input,
      createdAt: now,
      updatedAt: now,
      ...(input.state === "deleted" ? { deletedAt: now } : {}),
    };
    try {
      await dynamo.send(new PutItemCommand({
        TableName: artifactsTableName(),
        Item: recordToItem(record),
        ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(artifactId)",
      }));
      return record;
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      const existing = await dynamoArtifactStore.getById(accountId, input.conversationKey, artifactId);
      if (!existing || !sameArtifact(existing, input)) {
        throw new Error("Artifact idempotency key conflicts with an existing record");
      }
      return existing;
    }
  },

  async update(accountId, conversationKey, artifactId, rawPatch) {
    const patch = normalizeUpdateArtifactInput(rawPatch);
    const existing = await dynamoArtifactStore.getById(accountId, conversationKey, artifactId);
    if (!existing) return null;
    const externalRef = patch.externalRef === undefined ? existing.externalRef : patch.externalRef ?? undefined;
    const state = patch.state ?? existing.state;
    assertArtifactStateTransition(existing.state, state);
    if (state === "ready" && !externalRef) throw new Error("Ready artifacts require externalRef");

    const now = new Date().toISOString();
    const sets = ["updatedAt = :updatedAt"];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, AttributeValue> = {
      ":updatedAt": { S: now },
      ":conversationKey": { S: conversationKey },
      ":expectedState": { S: existing.state },
    };
    if (patch.state !== undefined) {
      sets.push("#state = :state");
      names["#state"] = "state";
      values[":state"] = { S: patch.state };
      if (patch.state === "deleted") {
        sets.push("deletedAt = :deletedAt");
        values[":deletedAt"] = { S: now };
      } else {
        removes.push("deletedAt");
      }
    }
    if (patch.driverId !== undefined) {
      sets.push("driverId = :driverId");
      values[":driverId"] = { S: patch.driverId };
    }
    if (patch.externalRef === null) removes.push("externalRef");
    else if (patch.externalRef !== undefined) {
      sets.push("externalRef = :externalRef");
      values[":externalRef"] = { S: patch.externalRef };
    }
    if (patch.failureCode === null) removes.push("failureCode");
    else if (patch.failureCode !== undefined) {
      sets.push("failureCode = :failureCode");
      values[":failureCode"] = { S: patch.failureCode };
    }
    const result = await dynamo.send(new UpdateItemCommand({
      TableName: artifactsTableName(),
      Key: { accountId: { S: accountId }, artifactId: { S: artifactId } },
      UpdateExpression: [
        `SET ${sets.join(", ")}`,
        ...(removes.length > 0 ? [`REMOVE ${removes.join(", ")}`] : []),
      ].join(" "),
      ConditionExpression: "attribute_exists(accountId) AND conversationKey = :conversationKey AND #state = :expectedState",
      ExpressionAttributeNames: { ...names, "#state": "state" },
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })).catch((error) => {
      if (isConditionalCheckFailed(error)) return null;
      throw error;
    });
    return result?.Attributes ? itemToRecord(result.Attributes) : null;
  },

  async remove(accountId, conversationKey, artifactId) {
    const updated = await dynamoArtifactStore.update(accountId, conversationKey, artifactId, {
      state: "deleted",
      externalRef: null,
    });
    return updated !== null;
  },

  async removeAllForAccount(accountId) {
    let deleted = 0;
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await dynamo.send(new QueryCommand({
        TableName: artifactsTableName(),
        KeyConditionExpression: "accountId = :accountId",
        ExpressionAttributeValues: { ":accountId": { S: accountId } },
        ProjectionExpression: "accountId, artifactId",
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }));
      const requests: WriteRequest[] = (result.Items ?? []).map((item) => ({
        DeleteRequest: { Key: { accountId: item.accountId!, artifactId: item.artifactId! } },
      }));
      for (let index = 0; index < requests.length; index += 25) {
        let pending = requests.slice(index, index + 25);
        let attempt = 0;
        while (pending.length > 0) {
          const batch = await dynamo.send(new BatchWriteItemCommand({
            RequestItems: { [artifactsTableName()]: pending },
          }));
          const unprocessed = batch.UnprocessedItems?.[artifactsTableName()] ?? [];
          deleted += pending.length - unprocessed.length;
          pending = unprocessed;
          if (pending.length > 0) {
            attempt += 1;
            if (attempt >= 5) throw new Error("Artifact cleanup retained unprocessed DynamoDB writes");
            await new Promise((resolve) => setTimeout(resolve, 10 * (2 ** (attempt - 1))));
          }
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return deleted;
  },
};
