import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse } from "next/server";

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
    const authorizationUrl = await getSignInUrl({ returnTo: returnTo });

    return NextResponse.redirect(authorizationUrl);
}
