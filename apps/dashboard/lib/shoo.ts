/** Shoo auth module wired for ConvexProviderWithAuth. */
import type { StartSignInOptions, UseShooAuthOptions } from "@shoojs/react";
import { createShooConvexAuth, useShooAuth } from "@shoojs/react";

type ShooConvexAuth = ReturnType<typeof createShooConvexAuth>;

let shooConvexAuth: ShooConvexAuth | null = null;

export const SHOO_AUTH_OPTIONS = {
  callbackPath: "/auth/callback",
  requestPii: true,
} satisfies UseShooAuthOptions;

function getShooConvexAuth(): ShooConvexAuth {
  if (!shooConvexAuth) {
    shooConvexAuth = createShooConvexAuth(SHOO_AUTH_OPTIONS);
  }
  return shooConvexAuth;
}

/** Hook passed to ConvexProviderWithAuth. */
export function useAuth() {
  if (typeof window === "undefined") {
    return {
      isLoading: true,
      isAuthenticated: false,
      fetchAccessToken: async () => null,
    };
  }
  return getShooConvexAuth().useAuth();
}

/** Redirect to Shoo sign-in. */
export function signIn(opts?: StartSignInOptions) {
  return getShooConvexAuth().signIn(opts);
}

/** Clear identity and reload page. */
export function signOut() {
  return getShooConvexAuth().signOut();
}

/** Hook for reading Shoo identity state without starting extra monitors. */
export function useShooSession(options?: Partial<UseShooAuthOptions>) {
  return useShooAuth({
    ...SHOO_AUTH_OPTIONS,
    autoSessionMonitor: false,
    ...options,
  });
}
