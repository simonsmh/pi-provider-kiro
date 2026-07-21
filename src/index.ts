// Feature 1: Extension Registration
//
// Entry point that wires all features together via pi.registerProvider().

import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKiroEndpoints, resolveApiRegion } from "./endpoints.js";
import { getKiroCliCredentials } from "./kiro-cli.js";
import { setExtensionContext } from "./login-ui.js";
import { getCachedModels, isCacheStale, kiroModels, updateKiroModelsCache } from "./models.js";
import type { KiroCredentials } from "./oauth.js";
import { loginKiro, refreshKiroToken } from "./oauth.js";
import { streamKiro } from "./stream.js";
import { fetchKiroUsage } from "./usage.js";

export { resolveApiRegion } from "./endpoints.js";
export type { KiroStreamEvent } from "./event-parser.js";
export { KIRO_MODEL_IDS, kiroModels, resolveKiroModel } from "./models.js";
export { streamKiro } from "./stream.js";

interface KiroModelRefreshContext {
  credential?: OAuthCredentials | { type: "api_key"; key: string };
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

async function refreshKiroModels(context: KiroModelRefreshContext): Promise<Model<Api>[]> {
  const credential = context.credential;
  if (!credential) return kiroModels;
  if (credential.type === "api_key") {
    const apiKey = (credential as { type: "api_key"; key: string }).key;
    const apiRegion = "us-east-1";
    if (context.allowNetwork && (context.force || isCacheStale(apiRegion))) {
      try {
        await updateKiroModelsCache(apiKey, apiRegion);
      } catch {
        // Fallback to cached
      }
    }
    if (context.signal?.aborted) return [];
    const cachedModels = getCachedModels(apiRegion);
    return cachedModels.length > 0 ? cachedModels : kiroModels;
  }

  const storedCredentials = credential as KiroCredentials;
  if (!storedCredentials.access) return kiroModels;

  const apiRegion = resolveApiRegion(storedCredentials.region);
  const profileArn = storedCredentials.profileArn;

  if (context.allowNetwork && (context.force || isCacheStale(apiRegion))) {
    try {
      await updateKiroModelsCache(storedCredentials.access, apiRegion, profileArn);
    } catch {
      // Fallback to cached
    }
  }
  if (context.signal?.aborted) return [];

  const cachedModels = getCachedModels(apiRegion);
  return cachedModels.length > 0 ? cachedModels : kiroModels;
}

export default function (pi: ExtensionAPI) {
  // Capture ctx for the custom TUI login component
  pi.on("session_start", async (_event, ctx) => {
    setExtensionContext(ctx);
  });
  pi.registerProvider("kiro", {
    baseUrl: getKiroEndpoints("us-east-1").runtime,
    api: "kiro-api",
    apiKey: "$KIRO_API_KEY",
    models: kiroModels,
    refreshModels: refreshKiroModels,
    oauth: {
      // Name reflects all supported auth methods: AWS Builder ID, Google, GitHub
      name: "Kiro (Builder ID / Google / GitHub)",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      getCliCredentials: getKiroCliCredentials,
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        const apiRegion = resolveApiRegion((cred as KiroCredentials).region);
        const cachedKiro = getCachedModels(apiRegion);
        const nonKiro = models.filter((m: Model<Api>) => m.provider !== "kiro");
        const credentialProfileArn = (cred as KiroCredentials).profileArn;
        const modifiedKiro = cachedKiro.map((m: Model<Api>) => ({
          ...m,
          baseUrl: getKiroEndpoints(apiRegion).runtime,
          kiroRegion: apiRegion,
          ...(credentialProfileArn ? { kiroProfileArn: credentialProfileArn } : {}),
        }));

        return [...nonKiro, ...modifiedKiro];
      },
      fetchUsage: fetchKiroUsage,
      // biome-ignore lint/suspicious/noExplicitAny: ProviderConfig.oauth doesn't include getCliCredentials but OAuthProviderInterface does
    } as any,
    streamSimple: streamKiro,
  } as any);
}
