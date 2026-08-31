// Feature 1: Extension Registration
//
// Entry point that wires all features together via pi.registerProvider().

import type { Api, Model, OAuthCredentials, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSafeError } from "./debug.js";
import { getKiroEndpoints, resolveApiRegion } from "./endpoints.js";
import { getKiroCliCredentials, getKiroCliSocialToken } from "./kiro-cli.js";
import { getKiroIdeCredentials } from "./kiro-ide.js";
import { setExtensionContext } from "./login-ui.js";
import { getCachedModels, isCacheStale, type KiroModel, updateKiroModelsCache } from "./models.js";
import type { KiroCredentials } from "./oauth.js";
import { loginKiro, refreshKiroToken } from "./oauth.js";
import { streamKiro } from "./stream.js";
import { fetchKiroUsage } from "./usage.js";

export { resolveApiRegion } from "./endpoints.js";
export type { KiroStreamEvent } from "./event-parser.js";
export {
  isKiroToolStructureRule,
  KIRO_TOOL_STRUCTURE_RULES,
  KIRO_VALIDATION_MESSAGES,
  type KiroRepairResult,
  type KiroToolStructureRule,
  type KiroValidationError,
  type KiroValidationResult,
  KiroValidationRule,
  kiroConversationEntries,
  repairKiroConversation,
  SYNTHETIC_FAILED_TOOL_RESULT_TEXT,
  validateKiroConversation,
  validateKiroToolStructure,
} from "./history-validator.js";
export { KiroManagementHttpError } from "./management.js";
export { KIRO_MODEL_IDS, kiroModels, resolveKiroModel } from "./models.js";
// Kiro's own error vocabulary and the predicates this provider classifies it
// with. Published so consumers can interpret a reason code without an error
// instance in hand (e.g. a persisted log line) instead of hardcoding copies of
// the literals, which drift when the service adds a code.
export type { KiroReasonCode } from "./retry.js";
export {
  CAPACITY_PATTERN,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  KIRO_REASON_CODES,
  NON_RETRYABLE_BODY_PATTERNS,
  TOO_BIG_PATTERNS,
} from "./retry.js";
export { streamKiro } from "./stream.js";
export {
  EMPTY_CONTENT_PLACEHOLDER,
  type KiroHistoryEntry,
  type KiroToolResult,
  type KiroToolUse,
  type KiroUserInputMessage,
} from "./transform.js";

/**
 * Host-driven catalog refresh. `oauth.modifyModels` only projects whatever the
 * cache already holds, so this is the path that actually fetches when the host
 * asks for a refresh or the cache has gone stale. The composer re-applies
 * `modifyModels` on top of the returned list, so region/profileArn projection
 * still happens here.
 *
 * Persistence uses the Kiro management file cache
 * (`updateKiroModelsCache` / `~/.pi/agent/kiro-management-models-cache.json`) rather than
 * `context.store`, so oauth/stream and host refresh share one catalog source.
 */
type KiroRefreshModelsContext = Omit<RefreshModelsContext, "credential" | "store"> & {
  credential?: RefreshModelsContext["credential"] | KiroCredentials;
  store?: RefreshModelsContext["store"];
};

async function refreshKiroModels(context: KiroRefreshModelsContext): Promise<KiroModel[]> {
  let credential = context.credential;
  if (!credential) {
    const apiKey = process.env.KIRO_API_KEY;
    credential = apiKey
      ? { type: "api_key", key: apiKey }
      : (getKiroCliSocialToken() ?? getKiroCliCredentials() ?? getKiroIdeCredentials());
  }

  const oauthCredential = credential && "access" in credential ? (credential as KiroCredentials) : undefined;
  const apiKey =
    credential &&
    "type" in credential &&
    credential.type === "api_key" &&
    "key" in credential &&
    typeof credential.key === "string"
      ? credential.key
      : undefined;
  const accessToken =
    typeof oauthCredential?.access === "string" && oauthCredential.access ? oauthCredential.access : apiKey;
  const region = resolveApiRegion(oauthCredential?.region);

  if (context.signal?.aborted) return [];

  if (accessToken && context.allowNetwork && (context.force || isCacheStale(region))) {
    try {
      await updateKiroModelsCache(accessToken, region, oauthCredential?.profileArn);
    } catch (error) {
      // Serve the cached catalog when discovery fails.
      console.warn(`[pi-provider-kiro] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
    }
  }

  return getCachedModels(region);
}

export default async function (pi: ExtensionAPI) {
  // Capture ctx for the custom TUI login component
  pi.on("session_start", async (_event, ctx) => {
    setExtensionContext(ctx);
  });
  const initialModels = await refreshKiroModels({ allowNetwork: true });
  pi.registerProvider("kiro", {
    baseUrl: getKiroEndpoints("us-east-1").runtime,
    api: "kiro-api",
    apiKey: "$KIRO_API_KEY",
    models: initialModels,
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
        const kiroToModify =
          cachedKiro.length > 0 ? cachedKiro : models.filter((model: Model<Api>) => model.provider === "kiro");
        const nonKiro = models.filter((m: Model<Api>) => m.provider !== "kiro");
        const credentialProfileArn = (cred as KiroCredentials).profileArn;
        const modifiedKiro = kiroToModify.map((m: Model<Api>) => ({
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
  });
}
