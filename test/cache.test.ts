import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedModels, isCacheStale, updateKiroModelsCache } from "../src/models.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
}));

describe("Kiro Models Cache Scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getCachedModels", () => {
    it("returns empty array when cache file does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const models = getCachedModels("us-east-1", "profile-a");
      expect(models).toEqual([]);
    });

    it("reads new format with profileArn key", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockCache = {
        "us-east-1#profile-a": {
          updatedAt: Date.now(),
          models: [{ id: "model-a" }],
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockCache));

      const models = getCachedModels("us-east-1", "profile-a");
      expect(models).toEqual([{ id: "model-a" }]);
    });

    it("reads new format with region-only key", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockCache = {
        "us-east-1": {
          updatedAt: Date.now(),
          models: [{ id: "model-b" }],
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockCache));

      const models = getCachedModels("us-east-1");
      expect(models).toEqual([{ id: "model-b" }]);
    });

    it("supports backward-compatible old array format", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockCache = {
        "us-east-1": [{ id: "model-c" }],
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockCache));

      const models = getCachedModels("us-east-1");
      expect(models).toEqual([{ id: "model-c" }]);
    });
  });

  describe("isCacheStale", () => {
    it("returns true when cache file does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(isCacheStale("us-east-1")).toBe(true);
    });

    it("returns true if cache entry is older than 1 hour", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockCache = {
        "us-east-1#profile-a": {
          updatedAt: Date.now() - 3601_000,
          models: [],
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockCache));
      expect(isCacheStale("us-east-1", "profile-a")).toBe(true);
    });

    it("returns false if cache entry is newer than 1 hour", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockCache = {
        "us-east-1#profile-a": {
          updatedAt: Date.now() - 1800_000,
          models: [],
        },
      };
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockCache));
      expect(isCacheStale("us-east-1", "profile-a")).toBe(false);
    });
  });

  describe("updateKiroModelsCache", () => {
    it("saves models using getCacheKey", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [
              {
                modelId: "claude-sonnet-4.6",
                additionalModelRequestFieldsSchema: {
                  properties: { thinking: {} },
                },
              },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);
      vi.mocked(existsSync).mockReturnValue(false);

      let writtenData = "";
      vi.mocked(writeFileSync).mockImplementation((_path, data) => {
        writtenData = data as string;
        return undefined;
      });

      await updateKiroModelsCache("token", "us-east-1", "profile-x");

      expect(writtenData).toContain("us-east-1#profile-x");
      const parsed = JSON.parse(writtenData);
      expect(parsed["us-east-1#profile-x"].models).toBeDefined();
      expect(parsed["us-east-1#profile-x"].models[0].id).toBe("claude-sonnet-4-6");

      vi.unstubAllGlobals();
    });

    it("keys cache under profile ARN region when it differs from SSO-mapped region", async () => {
      // SSO region eu-west-1 maps to eu-central-1 via API_REGION_MAP,
      // but the profile ARN lives in us-east-1. The cache should be keyed
      // under us-east-1 so readers using profileArn.split(':')[3] find it.
      const profileArn = "arn:aws:codewhisperer:us-east-1:123456:profile/test";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [
              {
                modelId: "claude-sonnet-4.6",
                additionalModelRequestFieldsSchema: {
                  properties: { thinking: {} },
                },
              },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);
      vi.mocked(existsSync).mockReturnValue(false);

      let writtenData = "";
      vi.mocked(writeFileSync).mockImplementation((_path, data) => {
        writtenData = data as string;
        return undefined;
      });

      // region is the SSO-mapped region (eu-central-1), but profile ARN is in us-east-1
      await updateKiroModelsCache("token", "eu-central-1", profileArn);

      const parsed = JSON.parse(writtenData);
      // Should be keyed under the profile ARN's region (us-east-1), not eu-central-1
      expect(parsed[`us-east-1#${profileArn}`]).toBeDefined();
      expect(parsed[`eu-central-1#${profileArn}`]).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });
});
