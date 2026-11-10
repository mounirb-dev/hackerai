import { createHash } from "node:crypto";

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();

jest.mock("../db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  newId: (prefix: string) => `${prefix}_test`,
  withTransaction: async (fn: (c: unknown) => unknown) =>
    fn({ query: (...args: unknown[]) => mockClientQuery(...args) }),
}));

import { WorkOS } from "../workos-node";

const now = new Date("2026-01-01T00:00:00Z");
const membershipRow = (over: Record<string, unknown> = {}) => ({
  id: "om_1",
  user_id: "user_1",
  organization_id: "org_1",
  role_slug: "admin",
  status: "active",
  created_at: now,
  updated_at: now,
  ...over,
});

describe("self-hosted WorkOS shim", () => {
  const workos = new WorkOS("unused", { clientId: "unused" });

  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    process.env.NEXT_PUBLIC_BASE_URL = "https://app.example.com/";
  });

  it("lists memberships with filters and exposes autoPagination", async () => {
    mockQuery.mockResolvedValueOnce([membershipRow()]);
    const page = await workos.userManagement.listOrganizationMemberships({
      userId: "user_1",
      organizationId: "org_1",
      statuses: ["active"],
    });

    expect(page.data).toEqual([
      expect.objectContaining({
        id: "om_1",
        userId: "user_1",
        organizationId: "org_1",
        role: { slug: "admin" },
        createdAt: now.toISOString(),
      }),
    ]);
    expect(await page.autoPagination()).toBe(page.data);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("user_id = $1");
    expect(sql).toContain("status = ANY($3::text[])");
    expect(params).toEqual(["user_1", "org_1", ["active"], 10]);
    expect((page as unknown as PromiseLike<unknown>).then).toBeUndefined();
  });

  it("creates and deletes memberships", async () => {
    mockQuery
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([membershipRow()]);
    const created = await workos.userManagement.createOrganizationMembership({
      userId: "user_1",
      organizationId: "org_1",
      roleSlug: "admin",
    });
    expect(created.role.slug).toBe("admin");
    expect(mockQuery.mock.calls[2][1]).toEqual([
      "om_test",
      "user_1",
      "org_1",
      "admin",
    ]);

    mockQuery.mockResolvedValueOnce([{ id: "om_1" }]);
    await expect(
      workos.userManagement.deleteOrganizationMembership("om_1"),
    ).resolves.toBeUndefined();

    mockQuery.mockResolvedValueOnce([]);
    await expect(
      workos.userManagement.deleteOrganizationMembership("om_missing"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("stores only the invitation token hash and returns the accept URL", async () => {
    mockQuery.mockImplementationOnce(async (_sql: string, p: unknown[]) => [
      {
        id: p[0],
        email: p[1],
        organization_id: p[2],
        inviter_user_id: p[3],
        role_slug: p[4],
        state: "pending",
        expires_at: p[6],
        created_at: now,
        updated_at: now,
      },
    ]);
    const invitation = await workos.userManagement.sendInvitation({
      email: "a@b.com",
      organizationId: "org_1",
      inviterUserId: "user_1",
      roleSlug: "member",
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    const storedHash = params[5] as string;
    expect(invitation.token).toBeTruthy();
    expect(storedHash).toBe(
      createHash("sha256").update(invitation.token!).digest("hex"),
    );
    expect(storedHash).not.toBe(invitation.token);
    expect(invitation.acceptInvitationUrl).toBe(
      `https://app.example.com/signup?invitation_token=${invitation.token}`,
    );
    expect(invitation.state).toBe("pending");
  });

  it("reports lapsed invitations as expired", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        id: "invitation_1",
        email: "a@b.com",
        organization_id: "org_1",
        state: "pending",
        expires_at: new Date(Date.now() - 1000),
        created_at: now,
        updated_at: now,
      },
    ]);
    const invitation =
      await workos.userManagement.getInvitation("invitation_1");
    expect(invitation.state).toBe("expired");
  });

  it("throws WorkOS-compatible 404 errors", async () => {
    mockQuery.mockResolvedValue([]);
    const error = await workos.userManagement
      .getUser("user_x")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: "NotFoundException",
      message: "User not found: 'user_x'.",
      status: 404,
      code: "entity_not_found",
    });
    await expect(
      workos.organizations.getOrganization("org_x"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      workos.userManagement.deleteUser("user_x"),
    ).rejects.toMatchObject({ code: "entity_not_found" });
  });

  it("merges organization updates and keeps unspecified fields", async () => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "org_1",
            name: "Acme",
            external_id: null,
            stripe_customer_id: null,
            metadata: { a: "1" },
          },
        ],
      })
      .mockImplementationOnce(async (_sql: string, p: unknown[]) => ({
        rows: [
          {
            id: p[0],
            name: p[1],
            external_id: p[2],
            stripe_customer_id: p[3],
            metadata: JSON.parse(p[4] as string),
            created_at: now,
            updated_at: now,
          },
        ],
      }));
    const org = await workos.organizations.updateOrganization({
      organization: "org_1",
      stripeCustomerId: "cus_1",
    });
    expect(org).toMatchObject({
      id: "org_1",
      name: "Acme",
      stripeCustomerId: "cus_1",
      metadata: { a: "1" },
      domains: [],
    });
  });

  it("revokes sessions and lists them by positional user id", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        id: "session_1",
        user_id: "user_1",
        expires_at: new Date(Date.now() + 1e6),
        revoked_at: null,
        created_at: now,
      },
    ]);
    const sessions = await workos.userManagement.listSessions("user_1");
    expect(sessions.data[0]).toMatchObject({
      id: "session_1",
      status: "active",
    });

    mockQuery.mockResolvedValueOnce([{ id: "session_1" }]);
    await workos.userManagement.revokeSession({ sessionId: "session_1" });
    expect(mockQuery.mock.calls[1][0]).toContain("revoked_at");
  });

  it("rejects session-layer methods that live elsewhere", () => {
    expect(() => workos.webhooks.constructEvent()).toThrow(
      "not supported by self-hosted auth",
    );
    expect(() => workos.userManagement.loadSealedSession()).toThrow(
      "not supported by self-hosted auth",
    );
  });
});
