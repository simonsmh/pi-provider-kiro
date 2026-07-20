// Feature 2: Model Definitions

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isApiKey, kiroAuthHeaders, kiroUserAgent } from "./oauth.js";

const CACHE_PATH = join(homedir(), ".pi", "agent", "kiro-models-cache.json");
const CATALOG_VERSION = 2;

function getCachedModelList(value: unknown): KiroModelDef[] | undefined {
  if (Array.isArray(value)) return value as KiroModelDef[];
  if (!value || typeof value !== "object") return undefined;
  const models = (value as { models?: unknown }).models;
  return Array.isArray(models) ? (models as KiroModelDef[]) : undefined;
}

function getCachedUpdatedAt(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
  return typeof updatedAt === "number" ? updatedAt : undefined;
}

function getCachedCatalogVersion(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const version = (value as { catalogVersion?: unknown }).catalogVersion;
  return typeof version === "number" ? version : undefined;
}

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export interface KiroModelDef {
  id: string;
  name: string;
  api: "kiro-api";
  provider: "kiro";
  baseUrl: string;
  reasoning: boolean;
  supportsEffort: boolean;
  defaultEffort?: string;
  effortValues?: string[];
  input: ("text" | "image")[];
  cost: typeof ZERO_COST;
  contextWindow: number;
  maxTokens: number;
}

interface KiroAvailableModel {
  modelId: string;
  modelName?: string;
  supportedInputTypes?: string[];
  tokenLimits?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
  };
  additionalModelRequestFieldsSchema?: {
    properties?: {
      thinking?: unknown;
      output_config?: {
        properties?: {
          effort?: {
            enum?: unknown;
            default?: unknown;
          };
        };
      };
    };
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function buildModelDef(model: KiroAvailableModel, baseUrl: string): KiroModelDef | undefined {
  const contextWindow = model.tokenLimits?.maxInputTokens;
  const maxTokens = model.tokenLimits?.maxOutputTokens;
  const input = [
    ...new Set(
      (model.supportedInputTypes ?? []).flatMap((inputType) => {
        switch (inputType.toUpperCase()) {
          case "TEXT":
            return ["text" as const];
          case "IMAGE":
            return ["image" as const];
          default:
            return [];
        }
      }),
    ),
  ];

  // Do not invent limits or capabilities: every model we expose must carry
  // the complete catalog metadata needed by pi.
  if (
    !model.modelName ||
    !isPositiveInteger(contextWindow) ||
    !isPositiveInteger(maxTokens) ||
    !input.includes("text")
  ) {
    return undefined;
  }

  const schemaProperties = model.additionalModelRequestFieldsSchema?.properties;
  const hasThinkingSchema = !!schemaProperties?.thinking;
  const effortSchema = schemaProperties?.output_config?.properties?.effort;
  const effortValues = Array.isArray(effortSchema?.enum)
    ? effortSchema.enum.filter((value): value is string => typeof value === "string")
    : [];
  const defaultEffort =
    typeof effortSchema?.default === "string" && effortValues.includes(effortSchema.default)
      ? effortSchema.default
      : undefined;
  const piId = model.modelId.replace(/(\d)\.(\d)/g, "$1-$2");

  return {
    id: piId,
    name: model.modelName,
    api: "kiro-api",
    provider: "kiro",
    baseUrl,
    reasoning: hasThinkingSchema,
    supportsEffort: effortValues.length > 0,
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(effortValues.length > 0 ? { effortValues } : {}),
    input,
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
  };
}

// Load models from disk cache at startup; empty until first successful auth.
function loadDefaultModels(): KiroModelDef[] {
  if (!existsSync(CACHE_PATH)) return [];
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    for (const entry of Object.values(data)) {
      const models = getCachedModelList(entry);
      if (models && models.length > 0) return models;
    }
  } catch {
    /* ignore */
  }
  return [];
}
export const defaultModels: KiroModelDef[] = loadDefaultModels();

// Valid Kiro model IDs — populated from cache
export const KIRO_MODEL_IDS = new Set<string>(defaultModels.map((m) => m.id.replace(/(\d)-(\d)/g, "$1.$2")));

let cachedIdsLoaded = false;
export function loadCachedModelIds(): void {
  if (cachedIdsLoaded) return;
  if (!existsSync(CACHE_PATH)) return;
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    for (const entry of Object.values(data)) {
      const regionModels = getCachedModelList(entry);
      if (regionModels) {
        for (const m of regionModels) {
          if (m.id) {
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
      const data = JSON.parse(raw) as Record<string, unknown>;
      const models = getCachedModelList(data[key]);
      if (models) return models;
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
    const data = JSON.parse(raw) as Record<string, unknown>;
    const key = getCacheKey(region, profileArn);
    const entry = data[key];
    if (!entry) return true;

    // Catalog entries written before v2 contain guessed limits and must be
    // refreshed before they are used as a source of model metadata.
    if (Array.isArray(entry) || getCachedCatalogVersion(entry) !== CATALOG_VERSION) return true;

    const updatedAt = getCachedUpdatedAt(entry) ?? 0;

    // Stale if older than 1 hour
    return Date.now() - updatedAt > 3600_000;
  } catch {
    return true;
  }
}

export async function discoverProfileArn(accessToken: string, preferredRegion: string): Promise<string | undefined> {
  const regionsToTry = preferredRegion === "us-east-1" ? [preferredRegion] : [preferredRegion, "us-east-1"];

  for (const region of regionsToTry) {
    const managementUrl = `https://management.${region}.kiro.dev/`;
    const target = isApiKey(accessToken)
      ? "AmazonCodeWhispererService.GetProfile"
      : "AmazonCodeWhispererService.ListAvailableProfiles";

    try {
      const r = await fetch(managementUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          ...kiroAuthHeaders(accessToken),
          ...kiroUserAgent("codewhispererruntime", "F,C"),
          "X-Amz-Target": target,
        },
        body: "{}",
      });

      if (!r.ok) continue;

      if (isApiKey(accessToken)) {
        const j = (await r.json()) as { profile?: { arn?: string } };
        if (j.profile?.arn) return j.profile.arn;
      } else {
        const j = (await r.json()) as { profiles?: Array<{ arn?: string }> };
        const arn = j.profiles?.find((p) => p.arn)?.arn;
        if (arn) return arn;
      }
    } catch {}
  }
  return undefined;
}

export async function updateKiroModelsCache(
  accessToken: string,
  region: string,
  profileArn?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // If no profileArn provided, try to discover it
  if (!profileArn) {
    profileArn = await discoverProfileArn(accessToken, region);
  }

  // Use the profile's region for management calls if available
  const effectiveRegion = profileArn?.split(":")[3] || region;

  try {
    const managementUrl = `https://management.${effectiveRegion}.kiro.dev/`;
    const response = await fetch(managementUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableModels",
        ...kiroAuthHeaders(accessToken),
        ...kiroUserAgent("codewhispererruntime", "F,C"),
      },
      body: JSON.stringify({
        origin: "KIRO_CLI",
        ...(profileArn ? { profileArn } : {}),
      }),
      signal,
    });

    if (!response.ok) {
      return profileArn;
    }

    const data = (await response.json()) as { models?: KiroAvailableModel[] };
    const fetchedModels = data.models || [];
    if (fetchedModels.length === 0) return profileArn;

    const newModels = fetchedModels.flatMap((model) => {
      const modelDef = buildModelDef(model, `https://runtime.${effectiveRegion}.kiro.dev/`);
      return modelDef ? [modelDef] : [];
    });
    if (newModels.length === 0) return profileArn;

    let cache: Record<string, unknown> = {};
    if (existsSync(CACHE_PATH)) {
      try {
        cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Record<string, unknown>;
      } catch {
        // Ignore parsing errors
      }
    }

    // Key with the effective/profile region so readers that look up by
    // profileArn.split(':')[3] find the same entry we just wrote.
    const key = getCacheKey(effectiveRegion, profileArn);
    cache[key] = {
      catalogVersion: CATALOG_VERSION,
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
  return profileArn;
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
