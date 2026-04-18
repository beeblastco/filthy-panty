import { NextResponse } from "next/server";

/**
 * Health check proxy for the agent gateway server.
 * @returns JSON with gateway health status
 */
export async function GET() {
    const gatewayUrl = process.env.NEXT_PUBLIC_AGENT_GATEWAY_URL!;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
        const response = await fetch(`${gatewayUrl}/healthz`, {
            method: "GET",
            signal: controller.signal,
        });

        if (response.ok) {
            return NextResponse.json({ status: "healthy" });
        }

        return NextResponse.json({ status: "unhealthy" }, { status: 502 });
    } catch {
        return NextResponse.json({ status: "unhealthy" }, { status: 502 });
    } finally {
        clearTimeout(timeoutId);
    }
}
