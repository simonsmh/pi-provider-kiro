import { describe, expect, it, vi } from "vitest";

const { existsSync, readFileSync } = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn((path: string) => {
    if (path.endsWith("kiro-auth-token.json")) {
      return JSON.stringify({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        region: "ap-northeast-1",
        provider: "Enterprise",
        clientIdHash: "client-hash",
      });
    }
    return JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" });
  }),
}));

vi.mock("node:fs", () => ({ existsSync, readFileSync }));
vi.mock("node:os", () => ({ homedir: () => "/home/test" }));

import { getKiroIdeCredentials } from "../src/kiro-ide.js";
import { isBuilderIdCredential } from "../src/oauth.js";

describe("Kiro IDE credentials", () => {
  it("preserves the Enterprise marker when its token has no start URL", () => {
    const credentials = getKiroIdeCredentials();

    expect(credentials).toMatchObject({
      authMethod: "idc",
      region: "ap-northeast-1",
      isEnterprise: true,
    });
    expect(credentials?.startUrl).toBeUndefined();
    expect(isBuilderIdCredential(credentials)).toBe(false);
  });
});
