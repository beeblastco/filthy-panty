import { handleAuth } from "@workos-inc/authkit-nextjs";

/**
 * Exchanges the WorkOS OAuth code for a session and redirects to the app.
 * @returns Redirect response after successful authentication
 */
export const GET = handleAuth({ returnPathname: "/" });
