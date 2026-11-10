import { afterEach, describe, expect, it, jest } from "@jest/globals";

const originalIssuer = process.env.AUTH_ISSUER;

async function loadAuthConfig(issuer?: string) {
  jest.resetModules();
  if (issuer === undefined) {
    delete process.env.AUTH_ISSUER;
  } else {
    process.env.AUTH_ISSUER = issuer;
  }
  return (await import("../auth.config")).default;
}

afterEach(() => {
  if (originalIssuer === undefined) {
    delete process.env.AUTH_ISSUER;
  } else {
    process.env.AUTH_ISSUER = originalIssuer;
  }
  jest.resetModules();
});

describe("Convex self-hosted auth configuration", () => {
  it("leaves providers empty when AUTH_ISSUER is unset", async () => {
    expect((await loadAuthConfig()).providers).toEqual([]);
  });

  it("trusts the app's own JWKS endpoint", async () => {
    const authConfig = await loadAuthConfig("https://hackerai.example.com/");

    expect(authConfig.providers).toEqual([
      {
        type: "customJwt",
        issuer: "https://hackerai.example.com",
        algorithm: "RS256",
        jwks: "https://hackerai.example.com/.well-known/jwks.json",
      },
    ]);
  });

  it("downloads keys from AUTH_JWKS_URL while keeping the public issuer", async () => {
    process.env.AUTH_JWKS_URL = "http://app:3000/.well-known/jwks.json";
    try {
      const authConfig = await loadAuthConfig("https://hackerai.example.com");

      expect(authConfig.providers[0]).toMatchObject({
        issuer: "https://hackerai.example.com",
        jwks: "http://app:3000/.well-known/jwks.json",
      });
    } finally {
      delete process.env.AUTH_JWKS_URL;
    }
  });

  it("accepts a bare hostname as an https origin", async () => {
    const authConfig = await loadAuthConfig("hackerai.example.com");

    expect(authConfig.providers[0]).toMatchObject({
      issuer: "https://hackerai.example.com",
    });
  });

  it.each([
    "https://hackerai.example.com/app",
    "https://hackerai.example.com?x=1",
    "https://user:pass@hackerai.example.com",
    "ftp://hackerai.example.com",
  ])("rejects an issuer that is not a bare origin: %s", async (issuer) => {
    await expect(loadAuthConfig(issuer)).rejects.toThrow(
      "AUTH_ISSUER must be a hostname or origin without a path",
    );
  });
});
