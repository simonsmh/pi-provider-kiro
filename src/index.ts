// Feature 1: Extension Registration
//
// Entry point that wires all features together via pi.registerProvider().

import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKiroCliCredentials } from "./kiro-cli.js";
import { setExtensionContext } from "./login-ui.js";
import { defaultModels, getCachedModels, resolveApiRegion } from "./models.js";
import type { KiroCredentials } from "./oauth.js";
import { loginKiro, refreshKiroToken } from "./oauth.js";
import { streamKiro } from "./stream.js";
import { fetchKiroUsage } from "./usage.js";

export default function (pi: ExtensionAPI) {
  // Capture ctx for the custom TUI login component
  pi.on("session_start", async (_event, ctx) => {
    setExtensionContext(ctx);
  });
  pi.registerProvider("kiro", {
    baseUrl: "https://runtime.us-east-1.kiro.dev/",
    api: "kiro-api",
    models: defaultModels,
    oauth: {
      // Web Login covers all browser-based auth methods: AWS Builder ID, Google, GitHub
      name: "Kiro (Web Login)",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      getCliCredentials: getKiroCliCredentials,
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        const ssoRegion = resolveApiRegion((cred as KiroCredentials).region);
        // If profileArn contains a region, prefer that for the runtime endpoint
        const profileRegion = (cred as KiroCredentials).profileArn?.split(":")[3];
        const apiRegion = profileRegion || ssoRegion;

        const cachedKiro = getCachedModels(apiRegion, (cred as KiroCredentials).profileArn);
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
  });
}
