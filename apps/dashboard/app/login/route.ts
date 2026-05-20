import { NextResponse } from "next/server";
import { getWorkOSRedirectUri } from "@/lib/authUrls";

export async function GET() {
    const { getSignInUrl } = await import("@workos-inc/authkit-nextjs");
    const redirectUri = getWorkOSRedirectUri();
    const authorizationUrl = await getSignInUrl({ returnTo: "/", redirectUri: redirectUri });

    return NextResponse.redirect(authorizationUrl);
}
