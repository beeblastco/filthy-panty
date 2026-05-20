import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse } from "next/server";

const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? "http://localhost:3000/auth/callback";

function parseReturnTo(value: string | null): string | null {
    if (!value?.startsWith("/")) {
        return null;
    }

    return value.startsWith("//") ? null : value;
}

/**
 * Route handler that redirects to the WorkOS sign-in page.
 * @returns Redirect to WorkOS AuthKit sign-in
 */
export async function GET(request: NextRequest) {
    const returnTo = parseReturnTo(request.nextUrl.searchParams.get("returnTo")) ?? "/";
    const authorizationUrl = await getSignInUrl({ returnTo: returnTo, redirectUri: redirectUri });

    return NextResponse.redirect(authorizationUrl);
}
