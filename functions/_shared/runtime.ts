export type LambdaHandler<TPayload = unknown, TResult = unknown> = (
  payload: TPayload,
  context: LambdaInvocation,
) => Promise<TResult>;

export interface LambdaInvocation {
  requestId: string;
  functionArn: string;
  traceId: string;
  deadlineMs: number;
}

const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
const NEXT_URL = `http://${RUNTIME_API}/2018-06-01/runtime/invocation/next`;

export async function startRuntime<TPayload, TResult>(
  handler: LambdaHandler<TPayload, TResult>,
): Promise<never> {
  for (;;) {
    const res = await fetch(NEXT_URL);
    const requestId = res.headers.get("lambda-runtime-aws-request-id")!;
    const functionArn = res.headers.get("lambda-runtime-invoked-functionarn") ?? "";
    const traceId = res.headers.get("lambda-runtime-trace-id") ?? "";
    const deadlineMs = Number(res.headers.get("lambda-runtime-deadline-ms") ?? "0");

    const payload = (await res.json()) as TPayload;
    const context: LambdaInvocation = { requestId, functionArn, traceId, deadlineMs };

    try {
      const result = await handler(payload, context);
      await fetch(
        `http://${RUNTIME_API}/2018-06-01/runtime/invocation/${requestId}/response`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(result),
        },
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      await fetch(
        `http://${RUNTIME_API}/2018-06-01/runtime/invocation/${requestId}/error`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            errorMessage: error.message,
            errorType: error.name,
            stackTrace: error.stack?.split("\n"),
          }),
        },
      );
    }
  }
}
