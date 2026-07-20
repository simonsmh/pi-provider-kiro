import { describe, expect, it, vi } from "vitest";
import {
  buildModelDef,
  defaultModels,
  discoverProfileArn,
  KIRO_MODEL_IDS,
  resolveApiRegion,
  resolveKiroModel,
  ZERO_COST,
} from "../src/models.js";

describe("Feature 2: Model Definitions", () => {
  describe("resolveKiroModel", () => {
    it("converts digit-dash-digit to dot format", () => {
      // With empty KIRO_MODEL_IDS, any ID is accepted
      expect(resolveKiroModel("claude-opus-4-6")).toBe("claude-opus-4.6");
      expect(resolveKiroModel("deepseek-3-2")).toBe("deepseek-3.2");
      expect(resolveKiroModel("glm-5")).toBe("glm-5");
    });
  });

  describe("KIRO_MODEL_IDS", () => {
    it("starts empty (populated from cache)", () => {
      // KIRO_MODEL_IDS is populated dynamically via loadCachedModelIds()
      expect(KIRO_MODEL_IDS).toBeInstanceOf(Set);
    });
  });

  describe("resolveApiRegion", () => {
    it("maps us-east-2 to us-east-1", () => {
      expect(resolveApiRegion("us-east-2")).toBe("us-east-1");
    });

    it("maps eu-west-1 to eu-central-1", () => {
      expect(resolveApiRegion("eu-west-1")).toBe("eu-central-1");
    });

    it("maps ap-southeast-2 to us-east-1", () => {
      expect(resolveApiRegion("ap-southeast-2")).toBe("us-east-1");
    });

    it("passes through us-east-1 unchanged", () => {
      expect(resolveApiRegion("us-east-1")).toBe("us-east-1");
    });

    it("defaults to us-east-1 when undefined", () => {
      expect(resolveApiRegion(undefined)).toBe("us-east-1");
    });
  });

  describe("buildModelDef", () => {
    it("uses the catalog limits, name, and input types", () => {
      const m = buildModelDef(
        {
          modelId: "gpt-5.6-luna",
          modelName: "gpt-5.6-luna",
          supportedInputTypes: ["TEXT", "IMAGE"],
          tokenLimits: { maxInputTokens: 272000, maxOutputTokens: 128000 },
        },
        "https://example.com",
      );
      expect(m).toEqual({
        id: "gpt-5-6-luna",
        name: "gpt-5.6-luna",
        api: "kiro-api",
        provider: "kiro",
        baseUrl: "https://example.com",
        reasoning: false,
        supportsEffort: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 272000,
        maxTokens: 128000,
      });
    });

    it("maps thinking and effort support from the catalog schema", () => {
      const m = buildModelDef(
        {
          modelId: "claude-opus-4.8",
          modelName: "claude-opus-4.8",
          supportedInputTypes: ["TEXT", "IMAGE"],
          tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 128000 },
          additionalModelRequestFieldsSchema: {
            properties: {
              thinking: {},
              output_config: { properties: { effort: { enum: ["low", "medium", "high"], default: "high" } } },
            },
          },
        },
        "https://example.com",
      );

      expect(m?.reasoning).toBe(true);
      expect(m?.supportsEffort).toBe(true);
      expect(m?.defaultEffort).toBe("high");
      expect(m?.effortValues).toEqual(["low", "medium", "high"]);
    });

    it("does not expose a model when catalog metadata is incomplete", () => {
      expect(
        buildModelDef(
          { modelId: "unknown", modelName: "unknown", supportedInputTypes: ["TEXT"] },
          "https://example.com",
        ),
      ).toBeUndefined();
    });
  });

  describe("defaultModels", () => {
    it("is an array (populated from cache if available)", () => {
      expect(Array.isArray(defaultModels)).toBe(true);
    });
  });

  describe("discoverProfileArn", () => {
    it("returns profile ARN from the first region when found", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: "arn:aws:codewhisperer:eu-central-1:123:profile/test" }] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const arn = await discoverProfileArn("tok", "eu-central-1");
      expect(arn).toBe("arn:aws:codewhisperer:eu-central-1:123:profile/test");
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0][0]).toBe("https://management.eu-central-1.kiro.dev/");

      vi.unstubAllGlobals();
    });

    it("falls back to us-east-1 when preferred region returns no profiles", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ profiles: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123:profile/test" }] }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const arn = await discoverProfileArn("tok", "eu-central-1");
      expect(arn).toBe("arn:aws:codewhisperer:us-east-1:123:profile/test");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe("https://management.eu-central-1.kiro.dev/");
      expect(mockFetch.mock.calls[1][0]).toBe("https://management.us-east-1.kiro.dev/");

      vi.unstubAllGlobals();
    });

    it("does not double-call us-east-1 when it is already the preferred region", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123:profile/test" }] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const arn = await discoverProfileArn("tok", "us-east-1");
      expect(arn).toBe("arn:aws:codewhisperer:us-east-1:123:profile/test");
      expect(mockFetch).toHaveBeenCalledOnce();

      vi.unstubAllGlobals();
    });

    it("returns undefined when no profile found in any region", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ profiles: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const arn = await discoverProfileArn("tok", "eu-central-1");
      expect(arn).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    });

    it("uses GetProfile for API keys instead of ListAvailableProfiles", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ profile: { arn: "arn:aws:codewhisperer:us-east-1:123:profile/api-key" } }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const arn = await discoverProfileArn("ksk_test_key", "us-east-1");
      expect(arn).toBe("arn:aws:codewhisperer:us-east-1:123:profile/api-key");
      expect(mockFetch.mock.calls[0][1].headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.GetProfile");

      vi.unstubAllGlobals();
    });
  });
});
