// Feature 2: Model Definitions

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const CACHE_PATH = join(homedir(), ".pi", "agent", "kiro-models-cache.json");

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export interface KiroModelDef {
  id: string;
  name: string;
  api: "kiro-api";
  provider: "kiro";
  baseUrl: string;
  reasoning: boolean;
  supportsEffort: boolean;
  thinkingLevelMap?: Record<string, string>;
  input: ("text" | "image")[];
  cost: typeof ZERO_COST;
  contextWindow: number;
  maxTokens: number;
  firstTokenTimeout?: number;
}

export function buildModelDef(
  piId: string,
  baseUrl: string,
  hasThinkingSchema: boolean,
  hasEffortSchema: boolean,
): KiroModelDef {
  const isClaude = piId.startsWith("claude");
  const isOpus = piId.includes("opus");
  const name = piId === "auto"
    ? "Auto"
    : piId.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  return {
    id: piId,
    name,
    api: "kiro-api",
    provider: "kiro",
    baseUrl,
    reasoning: hasThinkingSchema,
    supportsEffort: hasEffortSchema,
    ...(isOpus && hasEffortSchema
      ? { thinkingLevelMap: { minimal: "low", low: "medium", medium: "high", high: "xhigh" } }
      : {}),
    input: (isClaude || piId === "auto") ? ["text", "image"] : ["text"],
    cost: ZERO_COST,
    contextWindow: isClaude || piId === "auto" ? 1000000 : 200000,
    maxTokens: isOpus ? 128000 : isClaude || piId === "auto" ? 65536 : 8192,
    ...(isOpus ? { firstTokenTimeout: 180_000 } : {}),
  };
}

const DEFAULT_BASE_URL = "https://runtime.us-east-1.kiro.dev/";

// Load models from disk cache at startup; empty until first successful auth.
function loadDefaultModels(): KiroModelDef[] {
  if (!existsSync(CACHE_PATH)) return [];
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, any>;
    for (const entry of Object.values(data)) {
      const models = Array.isArray(entry) ? entry : entry?.models;
      if (Array.isArray(models) && models.length > 0) return models;
    }
  } catch { /* ignore */ }
  return [];
}
export const defaultModels: KiroModelDef[] = loadDefaultModels();

// Valid Kiro model IDs — populated from cache
export const KIRO_MODEL_IDS = new Set<string>(
  defaultModels.map((m) => m.id.replace(/(\d)-(\d)/g, "$1.$2"))
);

let cachedIdsLoaded = false;
export function loadCachedModelIds(): void {
  if (cachedIdsLoaded) return;
  if (!existsSync(CACHE_PATH)) return;
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, any>;
    for (const entry of Object.values(data)) {
      const regionModels = Array.isArray(entry) ? entry : entry?.models;
      if (Array.isArray(regionModels)) {
        for (const m of regionModels) {
          if (m?.id) {
            const kiroId = m.id.replace(/(\d)-(\d)/g, "$1.$2");
            KIRO_MODEL_IDS.add(kiroId);
          }
        }
      }
    }
    cachedIdsLoaded = true;
  } catch {
    // Ignore cache errors
  }
}

function getCacheKey(region: string, profileArn?: string): string {
  return profileArn ? `${region}#${profileArn}` : region;
}

export function getCachedModels(region: string, profileArn?: string): KiroModelDef[] {
  const key = getCacheKey(region, profileArn);
  if (existsSync(CACHE_PATH)) {
    try {
      const raw = readFileSync(CACHE_PATH, "utf-8");
      const data = JSON.parse(raw) as Record<string, any>;
      if (data && data[key]) {
        const entry = data[key];
        if (Array.isArray(entry)) {
          return entry;
        } else if (entry && Array.isArray(entry.models)) {
          return entry.models;
        }
      }
    } catch {
      // Ignore cache errors
    }
  }
  return [];
}

export function isCacheStale(region: string, profileArn?: string): boolean {
  if (!existsSync(CACHE_PATH)) return true;
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, any>;
    const key = getCacheKey(region, profileArn);
    if (!data || !data[key]) return true;

    const entry = data[key];
    let updatedAt = 0;
    if (Array.isArray(entry)) {
      // Old format: check file modification time
      const stat = statSync(CACHE_PATH);
      updatedAt = stat.mtimeMs;
    } else if (entry && typeof entry.updatedAt === "number") {
      updatedAt = entry.updatedAt;
    }

    // Stale if older than 1 hour
    return Date.now() - updatedAt > 3600_000;
  } catch {
    return true;
  }
}

export async function updateKiroModelsCache(accessToken: string, region: string, profileArn?: string): Promise<void> {
  try {
    const managementUrl = `https://management.${region}.kiro.dev/`;
    const response = await fetch(managementUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableModels",
        Authorization: `Bearer ${accessToken}`,
        // API keys (ksk_...) require this header or the control plane rejects them.
        ...(accessToken.startsWith("ksk_") ? { tokentype: "API_KEY" } : {}),
      },
      body: JSON.stringify({
        origin: "KIRO_CLI",
        ...(profileArn ? { profileArn } : {}),
      }),
    });

    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as {
      models?: Array<{
        modelId: string;
        additionalModelRequestFieldsSchema?: {
          properties?: {
            thinking?: unknown;
            output_config?: {
              properties?: {
                effort?: unknown;
              };
            };
          };
        };
      }>;
    };
    const fetchedModels = data.models || [];
    if (fetchedModels.length === 0) return;

    const newModels = fetchedModels.map((fm) => {
      const kiroId = fm.modelId;
      const piId = kiroId.replace(/(\d)\.(\d)/g, "$1-$2");

      const schemaProps = fm.additionalModelRequestFieldsSchema?.properties;
      const hasThinkingSchema = !!schemaProps?.thinking;
      const hasEffortSchema = !!schemaProps?.output_config?.properties?.effort;

      return buildModelDef(piId, `https://runtime.${region}.kiro.dev/`, hasThinkingSchema, hasEffortSchema);
    });

    if (!newModels.some((m) => m.id === "auto")) {
      newModels.push({
        id: "auto",
        name: "Auto",
        api: "kiro-api" as const,
        provider: "kiro" as const,
        baseUrl: `https://runtime.${region}.kiro.dev/`,
        reasoning: true,
        supportsEffort: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 1000000,
        maxTokens: 65536,
      });
    }

    let cache: Record<string, any> = {};
    if (existsSync(CACHE_PATH)) {
      try {
        cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
      } catch {
        // Ignore parsing errors
      }
    }

    const key = getCacheKey(region, profileArn);
    cache[key] = {
      updatedAt: Date.now(),
      models: newModels,
    };
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");

    cachedIdsLoaded = false;
    loadCachedModelIds();
  } catch (_error) {
    // Ignore fetch/cache errors
  }
}

export function resolveKiroModel(modelId: string): string {
  const kiroId = modelId.replace(/(\d)-(\d)/g, "$1.$2");
  loadCachedModelIds();
  // If cache is empty (first run before auth), accept any ID
  if (KIRO_MODEL_IDS.size > 0 && !KIRO_MODEL_IDS.has(kiroId)) {
    throw new Error(`Unknown Kiro model ID: ${modelId}`);
  }
  return kiroId;
}

/**
 * Map an SSO/OIDC region to the Kiro API region.
 *
 * The Kiro Q API is only deployed in a subset of regions. Tokens issued by
 * an SSO instance in e.g. eu-west-1 must be sent to the eu-central-1 API
 * endpoint. This mirrors the endpoint resolution that kiro-cli performs
 * internally via the AWS SDK partition resolver.
 */
const API_REGION_MAP: Record<string, string> = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-northeast-1": "us-east-1",
  "ap-south-1": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
};

export function resolveApiRegion(ssoRegion: string | undefined): string {
  if (!ssoRegion) return "us-east-1";
  return API_REGION_MAP[ssoRegion] ?? ssoRegion;
}

