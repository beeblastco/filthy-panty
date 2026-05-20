/**
 * Supabase REST client for harness-processing runtime helpers.
 * Keep PostgREST request mechanics here; domain logic belongs in feature modules.
 */

import { optionalEnv } from "../_shared/env.ts";

const SUPABASE_REST_PATH = "rest/v1/";

export class SupabaseRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Supabase request failed (${status}): ${body || "empty response"}`);
  }
}

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseConfig());
}

export async function supabaseRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  const config = supabaseConfig();
  if (!config) {
    throw new Error("Supabase is not configured");
  }

  const response = await fetch(supabaseUrl(config.url, path), {
    ...init,
    headers: {
      "Accept": "application/json",
      "apikey": config.serviceRoleKey,
      "Authorization": `Bearer ${config.serviceRoleKey}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new SupabaseRequestError(response.status, bodyText);
  }

  if (!bodyText.trim()) {
    return null;
  }

  return JSON.parse(bodyText) as T;
}

function supabaseConfig(): { url: string; serviceRoleKey: string } | null {
  const url = optionalEnv("SUPABASE_URL")?.trim();
  const serviceRoleKey = optionalEnv("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!url || !serviceRoleKey) {
    return null;
  }

  return { url, serviceRoleKey };
}

function supabaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`${SUPABASE_REST_PATH}${path.replace(/^\/+/, "")}`, base).toString();
}
