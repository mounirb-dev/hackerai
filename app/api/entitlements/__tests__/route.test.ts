import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockResolveSession = jest.fn<(cookie?: string) => Promise<unknown>>();

jest.mock("@/lib/selfhost/session-store", () => ({
  resolveSession: (cookie?: string) => mockResolveSession(cookie),
}));

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

function makeRequest(cookie?: string) {
  return {
    cookies: {
      get: jest.fn((name: string) =>
        name === "wos-session" && cookie ? { value: cookie } : undefined,
      ),
    },
  } as never;
}

describe("GET /api/entitlements", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects requests without a live session", async () => {
    mockResolveSession.mockResolvedValue(null);

    const { GET } = await import("../route");
    const response = await GET(makeRequest("stale.cookie"));

    expect(mockResolveSession).toHaveBeenCalledWith("stale.cookie");
    expect(response.status).toBe(401);
  });

  it("returns the session entitlements with the resolved tier", async () => {
    mockResolveSession.mockResolvedValue({
      entitlements: ["pro-plus-plan", 42],
    });

    const { GET } = await import("../route");
    const response = await GET(makeRequest("sid.secret"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      entitlements: ["pro-plus-plan"],
      subscription: "pro-plus",
    });
  });

  it("reports an empty entitlement list as the free tier", async () => {
    mockResolveSession.mockResolvedValue({ entitlements: [] });

    const { GET } = await import("../route");
    const response = await GET(makeRequest("sid.secret"));

    expect(await response.json()).toEqual({
      entitlements: [],
      subscription: "free",
    });
  });

  it("returns 500 when the session store is unavailable", async () => {
    mockResolveSession.mockRejectedValue(new Error("db down"));

    const { GET } = await import("../route");
    const response = await GET(makeRequest("sid.secret"));

    expect(response.status).toBe(500);
  });
});
