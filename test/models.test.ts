import { describe, expect, it } from "vitest";
import {
  buildModelDef,
  defaultModels,
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
    it("constructs standard Claude model definition", () => {
      const m = buildModelDef("claude-sonnet-4-6", "https://example.com", true, true);
      expect(m).toEqual({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4 6",
        api: "kiro-api",
        provider: "kiro",
        baseUrl: "https://example.com",
        reasoning: true,
        supportsEffort: true,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 1000000,
        maxTokens: 65536,
      });
    });

    it("constructs Opus model definition with thinkingLevelMap and timeout when effort is supported", () => {
      const m = buildModelDef("claude-opus-4-7", "https://example.com", true, true);
      expect(m).toEqual({
        id: "claude-opus-4-7",
        name: "Claude Opus 4 7",
        api: "kiro-api",
        provider: "kiro",
        baseUrl: "https://example.com",
        reasoning: true,
        supportsEffort: true,
        thinkingLevelMap: { minimal: "low", low: "medium", medium: "high", high: "xhigh" },
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 1000000,
        maxTokens: 128000,
        firstTokenTimeout: 180000,
      });
    });

    it("does not include thinkingLevelMap for Opus model when effort is not supported", () => {
      const m = buildModelDef("claude-opus-4-7", "https://example.com", true, false);
      expect(m.thinkingLevelMap).toBeUndefined();
      expect(m.firstTokenTimeout).toBe(180000);
    });

    it("constructs standard non-Claude model definition", () => {
      const m = buildModelDef("deepseek-3-2", "https://example.com", true, false);
      expect(m).toEqual({
        id: "deepseek-3-2",
        name: "Deepseek 3 2",
        api: "kiro-api",
        provider: "kiro",
        baseUrl: "https://example.com",
        reasoning: true,
        supportsEffort: false,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: 200000,
        maxTokens: 8192,
      });
    });

    it("constructs auto model definition", () => {
      const m = buildModelDef("auto", "https://example.com", true, false);
      expect(m.name).toBe("Auto");
      expect(m.input).toEqual(["text", "image"]);
      expect(m.contextWindow).toBe(1000000);
      expect(m.maxTokens).toBe(65536);
    });
  });

  describe("defaultModels", () => {
    it("is an array (populated from cache if available)", () => {
      expect(Array.isArray(defaultModels)).toBe(true);
    });
  });
});
