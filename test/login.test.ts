import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { interactiveLogin } from "../src/login.js";
import type { KiroCredentials } from "../src/oauth.js";
import { BUILDER_ID_START_URL } from "../src/oauth.js";

vi.mock("../src/kiro-cli.js", () => ({
  getKiroCliCredentials: vi.fn(() => undefined),
  getKiroCliCredentialsAllowExpired: vi.fn(() => undefined),
  getKiroCliSocialToken: vi.fn(() => undefined),
  getKiroCliSocialTokenAllowExpired: vi.fn(() => undefined),
  saveKiroCliCredentials: vi.fn(),
}));

let mockHttpServer: any = {
  listen: vi.fn((port, cb) => {
    if (cb) cb();
    if (mockHttpServer.handler) {
      const mockReq = { url: "/?code=mock_code&state=mock_state", headers: { host: "localhost:3128" } };
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };
      mockHttpServer.handler(mockReq, mockRes);
    }
  }),
  close: vi.fn(),
  on: vi.fn(),
};

vi.mock("node:http", () => ({
  default: {
    createServer: vi.fn((handler) => {
      mockHttpServer.handler = handler;
      return mockHttpServer;
    }),
  },
}));

vi.mock("node:crypto", () => ({
  default: {
    randomBytes: vi.fn((n) => ({
      toString: vi.fn(() => "mock_state"),
    })),
    createHash: vi.fn(() => ({
      update: vi.fn(() => ({
        digest: vi.fn(() => "mock_challenge"),
      })),
    })),
  },
}));

// Mock login-ui — no ctx available in tests, return null to exercise fallback
vi.mock("../src/login-ui.js", () => ({
  showLoginUI: vi.fn(() => Promise.resolve(null)),
  showWaitingUI: vi.fn((callbacks, choice, runAuth) => runAuth(callbacks)),
  hasExtensionContext: vi.fn(() => false),
  setExtensionContext: vi.fn(),
}));

function makeCallbacks(...responses: string[]): OAuthLoginCallbacks & { onAuth: ReturnType<typeof vi.fn> } {
  const onPrompt = vi.fn();
  for (const r of responses) onPrompt.mockResolvedValueOnce(r);
  onPrompt.mockResolvedValue("");
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt,
    onProgress: vi.fn(),
    signal: new AbortController().signal,
  } as OAuthLoginCallbacks & { onAuth: ReturnType<typeof vi.fn> };
}

function mockBuilderIdFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "cid", clientSecret: "csec" }) })
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          verificationUri: "https://device.sso.us-east-1.amazonaws.com",
          verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com?code=ABCD",
          userCode: "ABCD-1234",
          deviceCode: "dc",
          interval: 1,
          expiresIn: 10,
        }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 }),
    });
}

// us-east-1 device_authorization fails (wrong region), eu-west-1 succeeds
function mockIdcAutoDetectFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "c1", clientSecret: "s1" }) }) // us-east-1 register
    .mockResolvedValueOnce({ ok: false, status: 400 }) // us-east-1 device_auth → wrong region
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "c2", clientSecret: "s2" }) }) // eu-west-1 register
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          verificationUri: "u",
          verificationUriComplete: "u?code=X",
          userCode: "X",
          deviceCode: "dc",
          interval: 1,
          expiresIn: 10,
        }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 }),
    });
}

describe("Feature 10: Interactive Login", () => {
  describe("method selection (prompt 1)", () => {
    it("blank/1 → Builder ID", async () => {
      const mockFetch = mockBuilderIdFetch();
      vi.stubGlobal("fetch", mockFetch);
      const creds = await interactiveLogin(makeCallbacks(""));
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).startUrl).toBe(BUILDER_ID_START_URL);
      expect((creds as KiroCredentials).region).toBe("us-east-1");
      vi.unstubAllGlobals();
    });

    it("TUI: personal → native Web Login PKCE flow", async () => {
      const { showLoginUI } = await import("../src/login-ui.js");
      vi.mocked(showLoginUI).mockResolvedValueOnce({ method: "personal" });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accessToken: "at",
            refreshToken: "rt",
            expiresIn: 3600,
            profileArn: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = (await interactiveLogin(makeCallbacks(""))) as KiroCredentials;
      expect(creds.authMethod).toBe("desktop");
      expect(creds.access).toBe("at");
      expect(creds.refresh).toBe("rt|desktop");

      vi.unstubAllGlobals();
    });

    it("TUI: idc → IdC flow with auto-detect", async () => {
      const { showLoginUI } = await import("../src/login-ui.js");
      vi.mocked(showLoginUI).mockResolvedValueOnce({ method: "idc", startUrl: "https://mycompany.awsapps.com/start" });
      vi.stubGlobal("fetch", mockIdcAutoDetectFetch());
      const creds = await interactiveLogin(makeCallbacks(""));
      expect((creds as KiroCredentials).region).toBe("eu-west-1");
      vi.unstubAllGlobals();
    });

    it("TUI: idc with explicit region → IdC flow directly using specified region", async () => {
      const { showLoginUI } = await import("../src/login-ui.js");
      vi.mocked(showLoginUI).mockResolvedValueOnce({ method: "idc", startUrl: "https://mycompany.awsapps.com/start", region: "us-east-2" });
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "c", clientSecret: "s" }) })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              verificationUri: "u",
              verificationUriComplete: "u?code=X",
              userCode: "X",
              deviceCode: "dc",
              interval: 1,
              expiresIn: 10,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 }),
        });
      vi.stubGlobal("fetch", mockFetch);
      const creds = await interactiveLogin(makeCallbacks(""));
      expect((creds as KiroCredentials).region).toBe("us-east-2");
      expect(mockFetch.mock.calls[0][0]).toContain("https://oidc.us-east-2.amazonaws.com");
      vi.unstubAllGlobals();
    });

    it("TUI: null (cancelled) → falls back to onPrompt", async () => {
      // showLoginUI returns null (default mock), so fallback fires
      vi.stubGlobal("fetch", mockBuilderIdFetch());
      const creds = await interactiveLogin(makeCallbacks(""));
      expect((creds as KiroCredentials).region).toBe("us-east-1");
      vi.unstubAllGlobals();
    });

    it("TUI: personal with awsidc callback → transitions to device code flow", async () => {
      const { showLoginUI } = await import("../src/login-ui.js");
      vi.mocked(showLoginUI).mockResolvedValueOnce({ method: "personal" });

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "cid", clientSecret: "csec" }) })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              verificationUri: "https://device.sso.us-east-1.amazonaws.com",
              verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com?code=ABCD",
              userCode: "ABCD-1234",
              deviceCode: "dc",
              interval: 1,
              expiresIn: 10,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: "at_idc", refreshToken: "rt_idc", expiresIn: 3600 }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const originalListen = mockHttpServer.listen;
      mockHttpServer.listen = vi.fn((port, cb) => {
        if (cb) cb();
        if (mockHttpServer.handler) {
          const mockReq = { 
            url: "/signin/callback?login_option=awsidc&issuer_url=https%3A%2F%2Fd-9567aedac7.awsapps.com%2Fstart%2F&idc_region=ap-northeast-1&state=mock_state", 
            headers: { host: "localhost:3128" } 
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          mockHttpServer.handler(mockReq, mockRes);
        }
      });

      try {
        const creds = (await interactiveLogin(makeCallbacks(""))) as KiroCredentials;
        expect(creds.authMethod).toBe("idc");
        expect(creds.access).toBe("at_idc");
        expect(creds.refresh).toBe("rt_idc|cid|csec|idc");
        expect(creds.region).toBe("ap-northeast-1");
      } finally {
        mockHttpServer.listen = originalListen;
        vi.unstubAllGlobals();
      }
    });

    it("fallback: invalid non-URL input → throws", async () => {
      vi.stubGlobal("fetch", vi.fn());
      await expect(interactiveLogin(makeCallbacks("notaurl"))).rejects.toThrow("Invalid input");
      vi.unstubAllGlobals();
    });
  });

  describe("fallback — onPrompt path (no TUI ctx)", () => {
    it("URL → auto-detects region when region is empty", async () => {
      vi.stubGlobal("fetch", mockIdcAutoDetectFetch());
      const creds = await interactiveLogin(makeCallbacks("https://mycompany.awsapps.com/start", ""));
      expect((creds as KiroCredentials).region).toBe("eu-west-1");
      vi.unstubAllGlobals();
    });

    it("URL with explicit region → directly uses specified region", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "c", clientSecret: "s" }) })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              verificationUri: "u",
              verificationUriComplete: "u?code=X",
              userCode: "X",
              deviceCode: "dc",
              interval: 1,
              expiresIn: 10,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 }),
        });
      vi.stubGlobal("fetch", mockFetch);
      const creds = await interactiveLogin(makeCallbacks("https://mycompany.awsapps.com/start", "us-west-2"));
      expect((creds as KiroCredentials).region).toBe("us-west-2");
      expect(mockFetch.mock.calls[0][0]).toContain("https://oidc.us-west-2.amazonaws.com");
      vi.unstubAllGlobals();
    });

    it("blank → Builder ID", async () => {
      vi.stubGlobal("fetch", mockBuilderIdFetch());
      const creds = await interactiveLogin(makeCallbacks(""));
      expect((creds as KiroCredentials).region).toBe("us-east-1");
      vi.unstubAllGlobals();
    });

    it("all regions fail → throws helpful error", async () => {
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => {
          call++;
          if (call % 2 === 1)
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ clientId: "c", clientSecret: "s" }) });
          return Promise.resolve({ ok: false, status: 400 });
        }),
      );
      await expect(interactiveLogin(makeCallbacks("https://unknown.awsapps.com/start"))).rejects.toThrow(
        "Could not find",
      );
      vi.unstubAllGlobals();
    });
  });

  describe("device code polling", () => {
    it("throws on cancelled signal", async () => {
      const ac = new AbortController();
      ac.abort();
      const callbacks = { ...makeCallbacks(""), signal: ac.signal };
      vi.stubGlobal("fetch", mockBuilderIdFetch());
      await expect(interactiveLogin(callbacks)).rejects.toThrow("cancelled");
      vi.unstubAllGlobals();
    });

    it("increases polling interval on slow_down", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ clientId: "c", clientSecret: "s" }) })
          .mockResolvedValueOnce({
            ok: true,
            json: () =>
              Promise.resolve({
                verificationUri: "u",
                verificationUriComplete: "u",
                userCode: "X",
                deviceCode: "d",
                interval: 1,
                expiresIn: 30,
              }),
          })
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ error: "slow_down" }) })
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 }),
          }),
      );
      expect((await interactiveLogin(makeCallbacks(""))).access).toBe("at");
      vi.unstubAllGlobals();
    });
  });
});
