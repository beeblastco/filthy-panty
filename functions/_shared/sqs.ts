import type { SQSEvent, SQSBatchResponse, SQSRecord } from "aws-lambda";
import { logError } from "./log.ts";

export async function processSqsBatch(
  event: SQSEvent,
  processRecord: (record: SQSRecord) => Promise<void>,
): Promise<SQSBatchResponse> {
  const failures: string[] = [];

  await Promise.all(
    event.Records.map(async (record) => {
      try {
        await processRecord(record);
      } catch (err) {
        logError("SQS record processing failed", {
          messageId: record.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
        failures.push(record.messageId);
      }
    }),
  );

  return {
    batchItemFailures: failures.map((id) => ({ itemIdentifier: id })),
  };
}
