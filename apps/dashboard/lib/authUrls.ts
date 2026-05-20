/**
 * Returns the canonical WorkOS callback URL for the current environment.
 * This avoids redirecting users back to container bind addresses like 0.0.0.0.
 */
export function getWorkOSRedirectUri() {
  return process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? "http://localhost:3000/auth/callback";
}

/**
 * Returns the canonical app origin derived from the WorkOS callback URL.
 */
export function getWorkOSBaseUrl() {
  const redirectUri = getWorkOSRedirectUri();
  const url = new URL(redirectUri);

  return url.origin;
}
