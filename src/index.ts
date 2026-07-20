// Feature 1: Extension Registration
//
// Entry point that wires all features together via pi.registerProvider().

import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKiroCliCredentials } from "./kiro-cli.js";
import { getKiroIdeCredentials, getKiroIdeCredentialsAllowExpired } from "./kiro-ide.js";
import { setExtensionContext } from "./login-ui.js";
import type { KiroModelDef } from "./models.js";
import { defaultModels, getCachedModels, isCacheStale, resolveApiRegion, updateKiroModelsCache } from "./models.js";
import type { KiroCredentials } from "./oauth.js";
import { loginKiro, refreshKiroToken } from "./oauth.js";
import { streamKiro } from "./stream.js";
import { fetchKiroUsage } from "./usage.js";

/**
 * pi 0.80+ calls this hook while loading and opening the model selector.
 * Keep the narrow structural type here because this extension still supports
 * older pi type definitions that do not declare `refreshModels`.
 */
interface KiroModelRefreshContext {
  credential?: OAuthCredentials | { type: "api_key"; key: string };
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

const resolvedProfileArns = new Map<string, string>();

function refreshTokenId(credentials: Pick<KiroCredentials, "refresh">): string {
  return credentials.refresh.split("|", 1)[0] ?? "";
}

function usesSameRefreshToken(first: KiroCredentials, second: KiroCredentials): boolean {
  const firstId = refreshTokenId(first);
  return firstId.length > 0 && firstId === refreshTokenId(second);
}

function getCatalogTarget(credentials: KiroCredentials): { apiRegion: string; profileArn?: string } {
  const ssoRegion = resolveApiRegion(credentials.region);
  const profileArn = credentials.profileArn || resolvedProfileArns.get(refreshTokenId(credentials));
  const profileRegion = profileArn?.split(":")[3];
  return { apiRegion: profileRegion || ssoRegion, profileArn };
}

async function getCatalogCredentials(
  storedCredentials: KiroCredentials,
  context: KiroModelRefreshContext,
): Promise<KiroCredentials> {
  const ideCredentials = getKiroIdeCredentials() ?? getKiroIdeCredentialsAllowExpired();
  if (!ideCredentials?.isEnterprise || !usesSameRefreshToken(storedCredentials, ideCredentials)) {
    return storedCredentials;
  }
  if (Date.now() < ideCredentials.expires || !context.allowNetwork) return ideCredentials;

  try {
    return (await refreshKiroToken(ideCredentials)) as KiroCredentials;
  } catch {
    return storedCredentials;
  }
}

async function refreshKiroModels(context: KiroModelRefreshContext): Promise<KiroModelDef[]> {
  const credential = context.credential;
  if (!credential) return defaultModels;
  if (credential.type === "api_key") {
    const apiKey = (credential as { type: "api_key"; key: string }).key;
    const apiRegion = "us-east-1";
    const resolvedProfileArn =
      context.allowNetwork && (context.force || isCacheStale(apiRegion))
        ? await updateKiroModelsCache(apiKey, apiRegion, undefined, context.signal)
        : undefined;
    if (context.signal?.aborted) return [];
    const cachedModels = getCachedModels(apiRegion, resolvedProfileArn);
    return cachedModels.length > 0 ? cachedModels : defaultModels;
  }

  const storedCredentials = credential as KiroCredentials;
  if (!storedCredentials.access) return defaultModels;

  // v0.8.9 saved the Builder ID profile on enterprise IDE credentials. When
  // both sources share a refresh token, use the IDE's explicit Enterprise
  // marker to rediscover the correct profile without replacing other logins.
  const credentials = await getCatalogCredentials(storedCredentials, context);

  const { apiRegion, profileArn } = getCatalogTarget(credentials);
  const resolvedProfileArn =
    context.allowNetwork && (context.force || isCacheStale(apiRegion, profileArn))
      ? await updateKiroModelsCache(credentials.access, apiRegion, profileArn, context.signal)
      : profileArn;
  if (context.signal?.aborted) return [];
  if (resolvedProfileArn) resolvedProfileArns.set(refreshTokenId(credentials), resolvedProfileArn);

  const resolvedRegion = resolvedProfileArn?.split(":")[3] || apiRegion;
  const cachedModels = getCachedModels(resolvedRegion, resolvedProfileArn);
  // A pre-v0.8.10 credential may still contain the shared Builder ID profile
  // that v0.8.9 wrote for an enterprise IDE login. Its refresh is rejected by
  // the control plane, so retain an existing catalog until the user logs in
  // once with the corrected credential classification.
  return cachedModels.length > 0 ? cachedModels : defaultModels;
}

export default function (pi: ExtensionAPI) {
  // Capture ctx for the custom TUI login component
  pi.on("session_start", (_event, ctx) => {
    setExtensionContext(ctx);
  });
  pi.registerProvider("kiro", {
    baseUrl: "https://runtime.us-east-1.kiro.dev/",
    api: "kiro-api",
    apiKey: "$KIRO_API_KEY",
    models: defaultModels,
    refreshModels: refreshKiroModels,
    oauth: {
      // Web Login covers all browser-based auth methods: AWS Builder ID, Google, GitHub
      name: "Kiro (Web Login)",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      getCliCredentials: getKiroCliCredentials,
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        const { apiRegion, profileArn } = getCatalogTarget(cred as KiroCredentials);

        const cachedKiro = getCachedModels(apiRegion, profileArn);
        const nonKiro = models.filter((m: Model<Api>) => m.provider !== "kiro");
        const modelsToUse = cachedKiro.length > 0 ? cachedKiro : defaultModels;
        const modifiedKiro = modelsToUse.map((m: Model<Api>) => ({
          ...m,
          baseUrl: `https://runtime.${apiRegion}.kiro.dev/`,
        }));

        return [...nonKiro, ...modifiedKiro];
      },
      fetchUsage: fetchKiroUsage,
      // biome-ignore lint/suspicious/noExplicitAny: ProviderConfig.oauth doesn't include getCliCredentials but OAuthProviderInterface does
    } as any,
    streamSimple: streamKiro,
    // biome-ignore lint/suspicious/noExplicitAny: refreshModels is available in pi 0.80+, while the supported older type definitions omit it.
  } as any);
}
