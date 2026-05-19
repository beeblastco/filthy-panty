/** WorkOS AuthKit auth module wired for ConvexProviderWithAuth. */
import {
    AuthKitProvider,
    useAccessToken,
    useAuth as useAuthKit,
} from "@workos-inc/authkit-nextjs/components";
import { useCallback } from "react";

export { AuthKitProvider };

/**
 * Custom hook adapting WorkOS AuthKit authentication for Convex.
 * Uses getAccessToken() for guaranteed fresh tokens on every Convex request.
 * Read more: https://docs.convex.dev/auth/authkit/
 * @returns Authentication state and token fetcher for Convex
 */
export function useAuth() {
    const { user, loading: isLoading } = useAuthKit();
    const { getAccessToken, refresh } = useAccessToken();

    const fetchAccessToken = useCallback(
        async ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
            if (!user) {
                return null;
            }

            try {
                if (forceRefreshToken) {
                    return (await refresh()) ?? null;
                }

                return (await getAccessToken()) ?? null;
            } catch (error) {
                console.error("Failed to get access token:", error);
                return null;
            }
        },
        [user, refresh, getAccessToken],
    );

    return {
        isLoading: isLoading ?? false,
        isAuthenticated: !!user,
        fetchAccessToken: fetchAccessToken,
    };
}

/**
 * Hook for reading WorkOS identity state without starting extra monitors.
 * @returns User identity claims from WorkOS
 */
export function useWorkOSSession() {
    const { user, loading } = useAuthKit();

    return {
        loading: loading ?? false,
        identity: user
            ? {
                userId: user.id,
            }
            : null,
        claims: user
            ? {
                name: user.firstName && user.lastName
                    ? `${user.firstName} ${user.lastName}`.trim()
                    : user.email ?? "User",
                email: user.email ?? null,
                picture: user.profilePictureUrl ?? null,
            }
            : null,
    };
}

/**
 * Redirect to WorkOS sign-in.
 * @param opts Optional sign-in options including returnTo path
 */
export function signIn(opts?: { returnTo?: string }) {
    const returnTo = opts?.returnTo ?? "/";
    window.location.href = `/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * Clear identity and reload page via WorkOS sign-out.
 */
export async function signOut() {
    const { signOut: workosSignOut } = await import("@workos-inc/authkit-nextjs");
    await workosSignOut();
}
