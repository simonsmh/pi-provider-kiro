// Feature 3: OAuth — Kiro Authentication
//
// Supports multiple auth methods:
//   - "idc": AWS Builder ID or IAM Identity Center (SSO) via device code flow
//   - "desktop": Google/GitHub social login via Kiro auth service (delegates to kiro-cli)
//
// When no existing credentials are found (no Kiro IDE, no kiro-cli), falls back
// to the interactive login flow in login.ts (Feature 10).

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { getKiroIdeCredentials, getKiroIdeCredentialsAllowExpired } from "./kiro-ide.js";
import { interactiveLogin } from "./login.js";

export const SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
/**
 * Shared profile ARN that the official kiro-cli hardcodes for AWS Builder ID
 * (free-tier) tokens. Builder ID tokens are not authorized to call the
 * profile-management APIs (ListAvailableProfiles / ListProfiles / GetProfile
 * all reject them), so no per-user ARN can be discovered. kiro-cli instead
 * sends this constant ARN verbatim in ListAvailableModels and
 * GenerateAssistantResponse requests. Captured from kiro-cli 2.7.0 traffic.
 */
export const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const KIRO_DESKTOP_REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

export type KiroAuthMethod = "idc" | "desktop" | "apikey";
export type KiroLoginMethod = "auto" | "builder-id" | "google" | "github" | "apikey";

export interface KiroCredentials extends OAuthCredentials {
  clientId: string;
  clientSecret: string;
  region: string;
  authMethod: KiroAuthMethod;
  /** Required for Google/GitHub social profiles; ListAvailableProfiles may return empty for these tokens. */
  profileArn?: string;
  startUrl?: string;
}

/** Kiro API keys are bearer tokens prefixed with `ksk_`. */
export function isApiKey(token: string | undefined): boolean {
  return !!token && token.startsWith("ksk_");
}

/**
 * Whether a credential is an AWS Builder ID (free-tier) token.
 *
 * Builder ID tokens are device-code OIDC tokens with no IAM Identity Center
 * start URL — kiro-cli stores `start_url: null` for them, and our own login
 * flow tags them with the well-known Builder ID start URL. A real IAM
 * Identity Center org token always carries a custom company start URL, so the
 * absence of a start URL (or an exact match on the Builder ID URL) identifies
 * Builder ID. Social (Google/GitHub) logins use `authMethod: "desktop"` and
 * are excluded here.
 */
export function isBuilderIdCredential(creds: Pick<KiroCredentials, "authMethod" | "startUrl"> | undefined): boolean {
  if (!creds || creds.authMethod !== "idc") return false;
  return !creds.startUrl || creds.startUrl === BUILDER_ID_START_URL;
}

/**
 * Build the Authorization-related headers for a Kiro API request.
 * API keys (ksk_...) require the extra `tokentype: API_KEY` header; the
 * Kiro control plane rejects them with "Invalid token" otherwise.
 */
export function kiroAuthHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (isApiKey(accessToken)) {
    headers.tokentype = "API_KEY";
  }
  return headers;
}

/**
 * Login to Kiro using the specified method.
 *
 * - "auto": Use existing kiro-cli credentials if available (any method)
 * - "builder-id": AWS Builder ID via device code flow
 * - "google" | "github": Social login via kiro-cli (requires kiro-cli installed)
 */
export async function loginKiro(
  callbacks: OAuthLoginCallbacks,
  preferredMethod: KiroLoginMethod = "auto",
): Promise<OAuthCredentials> {
  const creds = await loginKiroInternal(callbacks, preferredMethod);
  if (!process.env.VITEST) {
    try {
      const { resolveApiRegion, updateKiroModelsCache } = await import("./models.js");
      const region = resolveApiRegion((creds as KiroCredentials).region);
      const kc = creds as KiroCredentials;
      const profileArn = kc.profileArn || (isBuilderIdCredential(kc) ? BUILDER_ID_PROFILE_ARN : undefined);
      await updateKiroModelsCache(creds.access, region, profileArn);
    } catch {
      // Ignore cache errors
    }
  }
  return creds;
}

/**
 * Login to Kiro using a KIRO_API_KEY (ksk_... format).
 *
 * API keys are bearer tokens used directly against the Kiro API — no OIDC
 * exchange, no kiro-cli dependency. The only requirements are:
 *   1. Send `Authorization: Bearer ksk_...` plus `tokentype: API_KEY`.
 *   2. Discover the profileArn via GetProfile (empty body returns the
 *      caller's own profile when authenticated with an API key).
 */
export async function loginKiroWithApiKey(callbacks: OAuthLoginCallbacks, apiKey: string): Promise<OAuthCredentials> {
  if (!apiKey.startsWith("ksk_")) {
    throw new Error("Invalid API key format. Kiro API keys start with 'ksk_'.");
  }

  (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.("Validating API key...");

  const { resolveApiRegion } = await import("./models.js");
  // API keys are issued for the us-east-1 control plane.
  const region = "us-east-1";
  const apiRegion = resolveApiRegion(region);
  const managementUrl = `https://management.${apiRegion}.kiro.dev/`;

  // GetProfile with an empty body returns the API key's own profile.
  let profileArn: string | undefined;
  const resp = await fetch(managementUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": "AmazonCodeWhispererService.GetProfile",
      ...kiroAuthHeaders(apiKey),
    },
    body: "{}",
  });

  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      detail = "";
    }
    if (resp.status === 401 || resp.status === 403 || /Invalid token/i.test(detail)) {
      throw new Error("API key was rejected by Kiro. Check that the key is valid and not expired.");
    }
    throw new Error(`Kiro GetProfile failed: ${resp.status} ${resp.statusText} ${detail}`.trim());
  }

  const data = (await resp.json()) as { profile?: { arn?: string } };
  profileArn = data.profile?.arn;

  const kiroCreds: KiroCredentials = {
    access: apiKey,
    // The API key acts as both access and refresh material; mark it for the
    // refresh path so we never attempt an OIDC refresh on it.
    refresh: `${apiKey}|apikey`,
    // API keys do not expire on a fixed schedule we can read; treat them as
    // long-lived and let the API surface a 401 if revoked.
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    clientId: "",
    clientSecret: "",
    region,
    authMethod: "apikey",
    profileArn,
  };

  if (!process.env.VITEST) {
    try {
      const { updateKiroModelsCache } = await import("./models.js");
      await updateKiroModelsCache(kiroCreds.access, apiRegion, kiroCreds.profileArn);
    } catch {
      // Ignore cache errors
    }
  }

  return kiroCreds;
}

async function loginKiroInternal(
  callbacks: OAuthLoginCallbacks,
  preferredMethod: KiroLoginMethod = "auto",
): Promise<OAuthCredentials> {
  const { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, saveKiroCliCredentials, getKiroCliSocialToken } =
    await import("./kiro-cli.js");

  // If user explicitly wants social login, delegate to kiro-cli
  if (preferredMethod === "google" || preferredMethod === "github") {
    const { runSocialLoginFlow } = await import("./login.js");
    return runSocialLoginFlow(callbacks, preferredMethod);
  }

  const hasCached = !!(
    getKiroIdeCredentials() ||
    getKiroCliSocialToken() ||
    getKiroCliCredentials() ||
    getKiroIdeCredentialsAllowExpired() ||
    getKiroCliCredentialsAllowExpired()
  );

  if (preferredMethod === "auto") {
    const choice = await interactiveLogin(callbacks, hasCached);
    if (choice === "use-cached-credentials") {
      return useCachedCascade(callbacks);
    }
    return choice;
  }

  // 1. Kiro IDE token (~/.aws/sso/cache/kiro-auth-token.json)
  //    Checked first because the IDE keeps it continuously fresh and it already
  //    covers IAM Identity Center logins — no extra prompts needed.
  const ideCreds = getKiroIdeCredentials();
  if (ideCreds && preferredMethod === "builder-id") {
    (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
      "Using existing Kiro IDE credentials",
    );
    return ideCreds;
  }

  // 2. kiro-cli DB credentials (social / Builder ID / IdC)
  let cliCreds = getKiroCliSocialToken();
  if (!cliCreds) {
    cliCreds = getKiroCliCredentials();
  }

  if (cliCreds && (preferredMethod === "builder-id" || cliCreds.authMethod === "idc")) {
    (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
      cliCreds.authMethod === "desktop"
        ? "Using existing kiro-cli social credentials"
        : "Using existing kiro-cli credentials",
    );
    return cliCreds;
  }

  // 3. Expired IDE token — attempt a silent AWS OIDC refresh
  const expiredIdeCreds = getKiroIdeCredentialsAllowExpired();
  if (expiredIdeCreds) {
    try {
      (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
        "Refreshing Kiro IDE credentials...",
      );
      return await refreshKiroTokenDirect(expiredIdeCreds);
    } catch {
      // Fall through to kiro-cli refresh
    }
  }

  // 4. Expired kiro-cli credentials — attempt a silent refresh
  const expiredCreds = getKiroCliCredentialsAllowExpired();
  if (expiredCreds) {
    try {
      (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
        "Refreshing expired kiro-cli credentials...",
      );
      const refreshed = await refreshKiroTokenDirect(expiredCreds);
      saveKiroCliCredentials(refreshed as KiroCredentials);
      return refreshed;
    } catch {
      // Refresh failed, fall through to device code flow
    }
  }

  const choice = await interactiveLogin(callbacks, hasCached);
  if (choice === "use-cached-credentials") {
    return useCachedCascade(callbacks);
  }
  return choice;
}

async function useCachedCascade(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, saveKiroCliCredentials, getKiroCliSocialToken } =
    await import("./kiro-cli.js");

  const ideCreds = getKiroIdeCredentials();
  if (ideCreds) {
    (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
      "Using existing Kiro IDE credentials",
    );
    return ideCreds;
  }

  let cliCreds = getKiroCliSocialToken();
  if (!cliCreds) {
    cliCreds = getKiroCliCredentials();
  }

  if (cliCreds) {
    (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
      cliCreds.authMethod === "desktop"
        ? "Using existing kiro-cli social credentials"
        : "Using existing kiro-cli credentials",
    );
    return cliCreds;
  }

  const expiredIdeCreds = getKiroIdeCredentialsAllowExpired();
  if (expiredIdeCreds) {
    try {
      (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
        "Refreshing Kiro IDE credentials...",
      );
      return await refreshKiroTokenDirect(expiredIdeCreds);
    } catch {
      // Ignore
    }
  }

  const expiredCreds = getKiroCliCredentialsAllowExpired();
  if (expiredCreds) {
    try {
      (callbacks as unknown as { onProgress?: (msg: string) => void }).onProgress?.(
        "Refreshing expired kiro-cli credentials...",
      );
      const refreshed = await refreshKiroTokenDirect(expiredCreds);
      saveKiroCliCredentials(refreshed as KiroCredentials);
      return refreshed;
    } catch {
      // Ignore
    }
  }

  throw new Error("No valid cached credentials found");
}

/**
 * Backward-compatible alias for loginKiro with Builder ID.
 * @deprecated Use loginKiro instead.
 */
export async function loginKiroBuilderID(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return loginKiro(callbacks, "builder-id");
}

// Token refresh buffer (5 minutes) baked into our expires timestamps at creation time.
// The actual AWS token is valid for this much longer than credentials.expires indicates.
const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

export async function refreshKiroToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const refreshed = await refreshKiroTokenInternal(credentials);
  if (!process.env.VITEST) {
    try {
      const { resolveApiRegion, updateKiroModelsCache } = await import("./models.js");
      const region = resolveApiRegion((refreshed as KiroCredentials).region);
      await updateKiroModelsCache(refreshed.access, region, (refreshed as KiroCredentials).profileArn);
    } catch {
      // Ignore cache errors
    }
  }
  return refreshed;
}

async function refreshKiroTokenInternal(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, saveKiroCliCredentials, getKiroCliSocialToken } =
    await import("./kiro-cli.js");

  // API key credentials are long-lived bearer tokens — there is nothing to
  // refresh. Return them unchanged so the same key keeps being used.
  if ((credentials as KiroCredentials).authMethod === "apikey" || isApiKey(credentials.access)) {
    return credentials;
  }

  // Layer 0: Kiro IDE token — freshest source, covers IAM Identity Center
  const ideCreds = getKiroIdeCredentials();
  if (ideCreds) return ideCreds;

  // Layer 1: Pre-refresh check — prefer social token if available (user logged in that way)
  // Otherwise check for any valid kiro-cli token
  let preCheckCreds = getKiroCliSocialToken();
  if (!preCheckCreds) {
    preCheckCreds = getKiroCliCredentials();
  }
  if (preCheckCreds) {
    return preCheckCreds;
  }

  try {
    const refreshed = await refreshKiroTokenDirect(credentials);

    // Layer 2: Write refreshed tokens back to kiro-cli's SQLite DB so both stay in sync.
    saveKiroCliCredentials(refreshed as KiroCredentials);

    return refreshed;
  } catch (refreshError) {
    // Layer 3: Refresh token may have been rotated by kiro-cli between our
    // Layer 1 check and the network call. Re-read kiro-cli's DB.
    const retryCreds = getKiroCliCredentials();
    if (retryCreds) {
      return retryCreds;
    }

    // Layer 4: kiro-cli may have a newer refresh token (expired access token).
    // Try refreshing with those credentials instead of the stale ones from auth.json.
    // Only attempt if the cli credentials differ from what we already tried.
    const expiredCliCreds = getKiroCliCredentialsAllowExpired();
    if (expiredCliCreds && expiredCliCreds.refresh !== credentials.refresh) {
      try {
        const refreshedFromCli = await refreshKiroTokenDirect(expiredCliCreds);
        saveKiroCliCredentials(refreshedFromCli as KiroCredentials);
        return refreshedFromCli;
      } catch {
        // Also failed, continue to remaining fallbacks
      }
    }

    // Layer 5: Graceful degradation — our expires has a 5-min buffer, so the
    // actual AWS token may still be valid. Return it to buy time.
    const actualExpiry = credentials.expires + EXPIRES_BUFFER_MS;
    if (credentials.access && Date.now() < actualExpiry) {
      return { ...credentials, expires: actualExpiry };
    }

    throw refreshError;
  }
}

async function refreshKiroTokenDirect(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] ?? "";
  const authMethod = (parts[parts.length - 1] ?? "idc") as KiroAuthMethod;
  const region = (credentials as KiroCredentials).region || "us-east-1";

  if (authMethod === "apikey") {
    // API keys are long-lived bearer tokens — no refresh needed.
    return credentials;
  }

  if (authMethod === "desktop") {
    // Kiro desktop app tokens use a different refresh endpoint
    const url = KIRO_DESKTOP_REFRESH_URL.replace("{region}", region);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) throw new Error(`Desktop token refresh failed: ${response.status}`);
    const data = (await response.json()) as {
      accessToken: string;
      refreshToken?: string;
      expiresIn: number;
      profileArn?: string;
    };
    if (!data.accessToken) throw new Error("Desktop token refresh: missing accessToken");
    return {
      refresh: `${data.refreshToken || refreshToken}|desktop`,
      access: data.accessToken,
      expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop" as KiroAuthMethod,
      profileArn: data.profileArn || (credentials as KiroCredentials).profileArn,
      startUrl: (credentials as KiroCredentials).startUrl,
    };
  }

  // IDC auth method — SSO OIDC refresh
  const clientId = parts[1] ?? "";
  const clientSecret = parts[2] ?? "";
  const ssoEndpoint = `https://oidc.${region}.amazonaws.com`;
  const response = await fetch(`${ssoEndpoint}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const data = (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
  return {
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|idc`,
    access: data.accessToken,
    expires: Date.now() + data.expiresIn * 1000 - 5 * 60 * 1000,
    clientId: clientId,
    clientSecret: clientSecret,
    region,
    authMethod: "idc" as KiroAuthMethod,
    profileArn: (credentials as KiroCredentials).profileArn,
    startUrl: (credentials as KiroCredentials).startUrl,
  };
}
