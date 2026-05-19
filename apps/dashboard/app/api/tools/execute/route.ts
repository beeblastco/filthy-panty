import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const clientId = process.env.WORKOS_CLIENT_ID;
const WORKOS_ISSUER = `https://api.workos.com/user_management/${clientId}`;
const WORKOS_JWKS = createRemoteJWKSet(new URL(`/user_management/jwks/${clientId}`, "https://api.workos.com"));

type ExecuteRequestBody = {
    language: "javascript" | "python";
    sourceCode: string;
    input?: unknown;
    timeoutMs?: number;
};

type ExecutorConfig = {
    url: string;
    secret: string;
    secretHeaderName: string;
};

/** Verify the WorkOS JWT from the Authorization header. */
async function verifyAuthToken(request: Request): Promise<boolean> {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
        return false;
    }

    const token = authHeader.slice(7);
    try {
        const { payload } = await jwtVerify(token, WORKOS_JWKS, {
            issuer: WORKOS_ISSUER,
        });

        if (typeof payload.sub !== "string") {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

/** Basic runtime validation for the execute payload coming from the tool test UI. */
function parseExecuteBody(payload: unknown): ExecuteRequestBody {
    if (typeof payload !== "object" || payload === null) {
        throw new Error("Request body must be a JSON object.");
    }

    const body = payload as Partial<ExecuteRequestBody>;

    if (body.language !== "javascript" && body.language !== "python") {
        throw new Error("language must be 'javascript' or 'python'.");
    }

    if (typeof body.sourceCode !== "string" || body.sourceCode.trim().length === 0) {
        throw new Error("sourceCode is required.");
    }

    if (body.timeoutMs !== undefined && typeof body.timeoutMs !== "number") {
        throw new Error("timeoutMs must be a number when provided.");
    }

    return {
        language: body.language,
        sourceCode: body.sourceCode,
        input: body.input ?? {},
        timeoutMs: body.timeoutMs,
    };
}

function resolveExecutorConfig(): ExecutorConfig | null {
    const url = process.env.CUSTOM_TOOL_EXECUTOR_URL?.trim().replace(/\/+$/, "") ?? "";
    const secret = process.env.CUSTOM_TOOL_EXECUTOR_SECRET?.trim() ?? "";

    if (!url && !secret) {
        return null;
    }

    if (!url || !secret) {
        throw new Error(
            "CUSTOM_TOOL_EXECUTOR_URL and CUSTOM_TOOL_EXECUTOR_SECRET must both be configured on the web server.",
        );
    }

    return {
        url,
        secret,
        secretHeaderName:
            process.env.CUSTOM_TOOL_EXECUTOR_SECRET_HEADER?.trim() || "X-Executor-Secret",
    };
}

export async function POST(request: Request) {
    let executorConfig: ExecutorConfig | null;
    try {
        executorConfig = resolveExecutorConfig();
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Invalid custom tool executor configuration.",
            },
            { status: 500 },
        );
    }
    if (!executorConfig) {
        return NextResponse.json(
            {
                error:
                    "CUSTOM_TOOL_EXECUTOR_URL and CUSTOM_TOOL_EXECUTOR_SECRET are not configured on the web server.",
            },
            { status: 500 },
        );
    }

    // Run auth verification and body parsing in parallel to avoid a network waterfall.
    const [isAuthenticated, rawPayload] = await Promise.all([
        verifyAuthToken(request),
        request.json().catch(() => null),
    ]);

    // Check authenticated user
    if (!isAuthenticated) {
        return NextResponse.json(
            { error: "User not found or not authenticated" },
            { status: 401 },
        );
    }

    if (rawPayload === null) {
        return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    let parsed: ExecuteRequestBody;
    try {
        parsed = parseExecuteBody(rawPayload);
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Invalid request." },
            { status: 400 },
        );
    }

    try {
        const upstream = await fetch(
            executorConfig.url,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    [executorConfig.secretHeaderName]: executorConfig.secret,
                },
                body: JSON.stringify(parsed),
            },
        );

        const body = (await upstream.json().catch(() => ({} as Record<string, unknown>))) as {
            error?: string;
            success?: boolean;
            output?: unknown;
        };

        if (!upstream.ok) {
            return NextResponse.json(
                {
                    error:
                        body.error
                        ?? `Executor request failed with status ${upstream.status}.`,
                },
                { status: upstream.status },
            );
        }

        return NextResponse.json(body, { status: 200 });
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Failed to reach the configured custom tool executor.",
            },
            { status: 502 },
        );
    }
}
