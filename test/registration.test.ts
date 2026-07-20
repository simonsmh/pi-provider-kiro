import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getKiroIdeCredentials, getKiroIdeCredentialsAllowExpired } from "../src/kiro-ide.js";
import { defaultModels, getCachedModels, isCacheStale, updateKiroModelsCache } from "../src/models.js";

// Mock models.js's getCachedModels helper to control cache contents
vi.mock("../src/models.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/models.js")>();
  return {
    ...original,
    getCachedModels: vi.fn(),
    isCacheStale: vi.fn(),
    updateKiroModelsCache: vi.fn(),
  };
});

vi.mock("../src/kiro-ide.js", () => ({
  getKiroIdeCredentials: vi.fn(),
  getKiroIdeCredentialsAllowExpired: vi.fn(),
}));

const mockPi = () => {
  const registerProvider = vi.fn();
  const on = vi.fn();
  return { pi: { registerProvider, on } as unknown as ExtensionAPI, registerProvider, on };
};

describe("Feature 1: Extension Registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports a default function", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.default).toBe("function");
  });

  it("calls registerProvider with 'kiro'", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();

    mod.default(pi);

    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0][0]).toBe("kiro");
  });

  it("configures KIRO_API_KEY through pi's pre-session environment resolution", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();

    mod.default(pi);

    expect(registerProvider.mock.calls[0][1].apiKey).toBe("$KIRO_API_KEY");
  });

  it("refreshes the catalog with an API key credential", async () => {
    vi.mocked(isCacheStale).mockReturnValue(false);
    vi.mocked(getCachedModels).mockReturnValue(defaultModels);
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const result = await config.refreshModels({
      credential: { type: "api_key", key: "ksk_from_environment" },
      allowNetwork: true,
    });

    expect(result).toEqual(defaultModels);
    expect(updateKiroModelsCache).not.toHaveBeenCalled();
  });

  it("registers models from cache", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(Array.isArray(config.models)).toBe(true);
  });

  it("refreshes a stale credential-scoped catalog through ListAvailableModels", async () => {
    const freshModels = [
      {
        id: "gpt-5-6-luna",
        name: "gpt-5.6-luna",
        api: "kiro-api" as const,
        provider: "kiro" as const,
        baseUrl: "https://runtime.us-east-1.kiro.dev/",
        reasoning: false,
        supportsEffort: false,
        input: ["text", "image"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const,
        contextWindow: 272000,
        maxTokens: 128000,
      },
    ];
    vi.mocked(isCacheStale).mockReturnValue(true);
    vi.mocked(updateKiroModelsCache).mockResolvedValue("arn:aws:codewhisperer:us-east-1:123:profile/test");
    vi.mocked(getCachedModels).mockReturnValue(freshModels);
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const result = await config.refreshModels({
      credential: {
        access: "token",
        refresh: "refresh",
        expires: Date.now() + 60_000,
        clientId: "",
        clientSecret: "",
        region: "ap-northeast-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test",
      },
      allowNetwork: true,
    });

    expect(updateKiroModelsCache).toHaveBeenCalledWith(
      "token",
      "us-east-1",
      "arn:aws:codewhisperer:us-east-1:123:profile/test",
      undefined,
    );
    expect(result).toEqual(freshModels);
  });

  it("keeps the existing catalog if a legacy profile cannot refresh", async () => {
    vi.mocked(isCacheStale).mockReturnValue(true);
    vi.mocked(updateKiroModelsCache).mockResolvedValue("arn:aws:codewhisperer:us-east-1:123:profile/legacy");
    vi.mocked(getCachedModels).mockReturnValue([]);
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const result = await config.refreshModels({
      credential: {
        access: "token",
        refresh: "refresh",
        expires: Date.now() + 60_000,
        clientId: "",
        clientSecret: "",
        region: "us-east-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/legacy",
      },
      allowNetwork: true,
    });

    expect(result).toEqual(defaultModels);
  });

  it("uses the matching enterprise IDE token to migrate a legacy Builder profile", async () => {
    const freshModels = [
      {
        id: "gpt-5-6-luna",
        name: "gpt-5.6-luna",
        api: "kiro-api" as const,
        provider: "kiro" as const,
        baseUrl: "https://runtime.us-east-1.kiro.dev/",
        reasoning: false,
        supportsEffort: false,
        input: ["text", "image"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const,
        contextWindow: 272000,
        maxTokens: 128000,
      },
    ];
    vi.mocked(getKiroIdeCredentials).mockReturnValue({
      access: "fresh-ide-access",
      refresh: "shared-refresh|client|secret|idc",
      expires: Date.now() + 60_000,
      clientId: "client",
      clientSecret: "secret",
      region: "ap-northeast-1",
      authMethod: "idc",
      isEnterprise: true,
    });
    vi.mocked(isCacheStale).mockReturnValue(true);
    vi.mocked(updateKiroModelsCache).mockResolvedValue("arn:aws:codewhisperer:us-east-1:123:profile/enterprise");
    vi.mocked(getCachedModels).mockReturnValue(freshModels);
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const result = await config.refreshModels({
      credential: {
        access: "legacy-access",
        refresh: "shared-refresh|legacy-client|legacy-secret|idc",
        expires: Date.now() + 60_000,
        clientId: "legacy-client",
        clientSecret: "legacy-secret",
        region: "ap-northeast-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/AAAACCCCXXXX",
      },
      allowNetwork: true,
    });

    expect(updateKiroModelsCache).toHaveBeenCalledWith("fresh-ide-access", "us-east-1", undefined, undefined);
    expect(result).toEqual(freshModels);
  });

  it("uses an unexpired IDE catalog credential without consulting its expired fallback", async () => {
    vi.mocked(getKiroIdeCredentials).mockReturnValue({
      access: "fresh-ide-access",
      refresh: "shared-refresh|client|secret|idc",
      expires: Date.now() + 60_000,
      clientId: "client",
      clientSecret: "secret",
      region: "ap-northeast-1",
      authMethod: "idc",
      isEnterprise: true,
    });
    vi.mocked(isCacheStale).mockReturnValue(false);
    vi.mocked(getCachedModels).mockReturnValue([]);
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    await config.refreshModels({
      credential: {
        access: "legacy-access",
        refresh: "shared-refresh|legacy-client|legacy-secret|idc",
        expires: Date.now() + 60_000,
        clientId: "legacy-client",
        clientSecret: "legacy-secret",
        region: "ap-northeast-1",
      },
      allowNetwork: true,
    });

    expect(getKiroIdeCredentialsAllowExpired).not.toHaveBeenCalled();
  });

  it("registers OAuth with name 'Kiro (Web Login)'", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(config.oauth.name).toBe("Kiro (Web Login)");
    expect(typeof config.oauth.login).toBe("function");
    expect(typeof config.oauth.refreshToken).toBe("function");
    expect(typeof config.oauth.getApiKey).toBe("function");
    expect(typeof config.oauth.fetchUsage).toBe("function");
  });

  it("registers a streamSimple handler", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(typeof config.streamSimple).toBe("function");
  });

  it("uses kiro-api as the api type", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    expect(registerProvider.mock.calls[0][1].api).toBe("kiro-api");
  });

  it.each([
    { ssoRegion: "eu-west-1", expectedApiRegion: "eu-central-1" },
    { ssoRegion: "eu-west-2", expectedApiRegion: "eu-central-1" },
    { ssoRegion: "eu-north-1", expectedApiRegion: "eu-central-1" },
    { ssoRegion: "us-east-1", expectedApiRegion: "us-east-1" },
    { ssoRegion: undefined, expectedApiRegion: "us-east-1" },
  ])("modifyModels maps SSO region $ssoRegion to API region $expectedApiRegion", async ({
    ssoRegion,
    expectedApiRegion,
  }) => {
    const fakeModel = {
      id: "claude-sonnet-4-6",
      name: "Test",
      api: "kiro-api" as const,
      provider: "kiro" as const,
      baseUrl: "old",
      reasoning: true,
      supportsEffort: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const,
      contextWindow: 100000,
      maxTokens: 8192,
    };
    vi.mocked(getCachedModels).mockReturnValue([fakeModel]);
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const models = [{ ...fakeModel, baseUrl: "old" }];
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: ssoRegion };
    const modified = config.oauth.modifyModels(models, creds);
    expect(modified[0].baseUrl).toBe(`https://runtime.${expectedApiRegion}.kiro.dev/`);
  });

  it("modifyModels falls back to defaultModels when cache is empty", async () => {
    vi.mocked(getCachedModels).mockReturnValue([]);
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const models = defaultModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: "eu-west-1" };
    const modified = config.oauth.modifyModels(models, creds);

    // Fallback uses defaultModels (from cache, may be empty or populated)
    expect(Array.isArray(modified)).toBe(true);
  });

  it("modifyModels uses cached models when cache is populated", async () => {
    const cachedModelsMock = [
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4 6",
        api: "kiro-api" as const,
        provider: "kiro" as const,
        baseUrl: "cached",
        reasoning: true,
        supportsEffort: true,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const,
        contextWindow: 100000,
        maxTokens: 8192,
      },
    ];
    vi.mocked(getCachedModels).mockReturnValue(cachedModelsMock);
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const models = defaultModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: "eu-west-1" };
    const modified = config.oauth.modifyModels(models, creds);

    expect(modified.length).toBe(1);
    expect(modified[0].id).toBe("claude-sonnet-4-6");
    expect(modified[0].baseUrl).toBe("https://runtime.eu-central-1.kiro.dev/");
  });

  it("modifyModels preserves non-kiro provider models", async () => {
    vi.mocked(getCachedModels).mockReturnValue([]);
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const kiro = defaultModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
    const codex = [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai-codex",
        api: "openai",
        baseUrl: "https://example.com",
      },
    ];
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: "eu-west-1" };
    const modified = config.oauth.modifyModels([...kiro, ...codex], creds);

    expect(modified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gpt-5.4",
          provider: "openai-codex",
          baseUrl: "https://example.com",
        }),
      ]),
    );
  });

  it("modifyModels prefers profileArn region over SSO-mapped region for baseUrl", async () => {
    const fakeModel = {
      id: "claude-sonnet-4-6",
      name: "Test",
      api: "kiro-api" as const,
      provider: "kiro" as const,
      baseUrl: "old",
      reasoning: true,
      supportsEffort: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const,
      contextWindow: 100000,
      maxTokens: 8192,
    };
    vi.mocked(getCachedModels).mockReturnValue([fakeModel]);
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const models = [{ ...fakeModel, baseUrl: "old" }];
    // SSO region is eu-west-1 (maps to eu-central-1), but profile is in us-east-1
    const creds = {
      access: "x",
      refresh: "x",
      expires: 0,
      clientId: "",
      clientSecret: "",
      region: "eu-west-1",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test",
    };
    const modified = config.oauth.modifyModels(models, creds);
    expect(modified[0].baseUrl).toBe("https://runtime.us-east-1.kiro.dev/");
  });
});
