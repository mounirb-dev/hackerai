import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockWithAuth = jest.fn();
const mockListOrganizationMemberships = jest.fn();
const mockGetOrganization = jest.fn();

jest.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: mockWithAuth,
}));

jest.mock("@/app/api/workos", () => ({
  workos: {
    userManagement: {
      listOrganizationMemberships: mockListOrganizationMemberships,
    },
    organizations: { getOrganization: mockGetOrganization },
  },
}));

describe("getBillingActionContext", () => {
  beforeEach(() => {
    jest.resetModules();
    mockWithAuth.mockReset();
    mockListOrganizationMemberships.mockReset();
  });

  it("normalizes ended-session refresh failures as unauthenticated billing context errors", async () => {
    const endedSessionError = Object.assign(
      new Error("Failed to refresh session: Error: invalid_grant"),
      {
        name: "TokenRefreshError",
        cause: {
          error: "invalid_grant",
          errorDescription: "Session has already ended.",
          rawData: {
            error: "invalid_grant",
            error_description: "Session has already ended.",
          },
        },
      },
    );
    mockWithAuth.mockRejectedValue(endedSessionError as never);

    const { getBillingActionContext } = await import("../billing-context");

    await expect(getBillingActionContext()).rejects.toThrow(
      "User not authenticated",
    );
    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
  });

  it("rethrows non-ended-session auth failures unchanged", async () => {
    const genericError = new Error("network failure");
    mockWithAuth.mockRejectedValue(genericError as never);

    const { getBillingActionContext } = await import("../billing-context");

    await expect(getBillingActionContext()).rejects.toBe(genericError);
    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
  });
});

describe("read-only billing status for unscoped users", () => {
  const membership = { organizationId: "org_single", role: { slug: "admin" } };
  const memberships = (data: unknown[], all = data) => ({
    data,
    autoPagination: jest.fn().mockResolvedValue(all as never),
  });

  beforeEach(() => {
    jest.resetModules();
    mockWithAuth.mockReset();
    mockListOrganizationMemberships.mockReset();
    mockGetOrganization.mockReset();
    mockWithAuth.mockResolvedValue({ user: { id: "user_free" } } as never);
    mockGetOrganization.mockResolvedValue({
      id: "org_single",
      stripeCustomerId: "cus_single",
    } as never);
  });

  it("recognizes a signed-in free user with no memberships without querying Stripe organization details", async () => {
    mockListOrganizationMemberships.mockResolvedValue(memberships([]) as never);
    const { getBillingStatusContext } = await import("../billing-context");
    await expect(getBillingStatusContext()).resolves.toBeNull();
    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_free",
      statuses: ["active"],
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
  });

  it("resolves one existing organization so an unscoped past-due user is not mistaken for a new free user", async () => {
    mockListOrganizationMemberships.mockResolvedValue(
      memberships([membership]) as never,
    );
    const { getBillingStatusContext } = await import("../billing-context");
    await expect(getBillingStatusContext()).resolves.toEqual({
      user: { id: "user_free" },
      organizationId: "org_single",
      stripeCustomerId: "cus_single",
    });
    expect(mockGetOrganization).toHaveBeenCalledWith("org_single");
  });

  it("checks all membership pages before rejecting ambiguous organization selection", async () => {
    mockListOrganizationMemberships.mockResolvedValue(
      memberships(
        [membership],
        [membership, { ...membership, organizationId: "org_other" }],
      ) as never,
    );
    const { getBillingStatusContext } = await import("../billing-context");
    await expect(getBillingStatusContext()).rejects.toThrow(
      "No organization found",
    );
    expect(mockGetOrganization).not.toHaveBeenCalled();
  });

  it("propagates membership lookup failures instead of declaring the user free", async () => {
    mockListOrganizationMemberships.mockRejectedValue(
      new Error("WorkOS unavailable") as never,
    );
    const { getBillingStatusContext } = await import("../billing-context");
    await expect(getBillingStatusContext()).rejects.toThrow(
      "WorkOS unavailable",
    );
  });

  it("preserves admin authorization for the resolved organization", async () => {
    mockListOrganizationMemberships.mockResolvedValue(
      memberships([{ ...membership, role: { slug: "member" } }]) as never,
    );
    const { getBillingStatusContext } = await import("../billing-context");
    await expect(getBillingStatusContext()).rejects.toThrow(
      "Only admins or owners can manage billing",
    );
    expect(mockGetOrganization).not.toHaveBeenCalled();
  });

  it("never falls back from a selected organization without membership", async () => {
    mockWithAuth.mockResolvedValue({
      user: { id: "user_free" },
      organizationId: "org_forbidden",
    } as never);
    mockListOrganizationMemberships.mockResolvedValue(memberships([]) as never);
    const { getBillingStatusContext } = await import("../billing-context");
    await expect(getBillingStatusContext()).rejects.toThrow(
      "User is not a member of this organization",
    );
    expect(mockGetOrganization).not.toHaveBeenCalled();
  });

  it("recognizes an authorized organization without a billing account", async () => {
    mockListOrganizationMemberships.mockResolvedValue(
      memberships([membership]) as never,
    );
    mockGetOrganization.mockResolvedValue({ id: "org_single" } as never);
    const { getBillingStatusContext } = await import("../billing-context");
    await expect(getBillingStatusContext()).resolves.toBeNull();
  });

  it("still requires an explicit organization for billing mutations", async () => {
    const { getBillingActionContext } = await import("../billing-context");
    await expect(getBillingActionContext()).rejects.toThrow(
      "No organization found",
    );
    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
  });

  it("still rejects signed-out status requests", async () => {
    mockWithAuth.mockResolvedValue({ user: null } as never);
    const { getBillingStatusContext } = await import("../billing-context");
    await expect(getBillingStatusContext()).rejects.toThrow(
      "User not authenticated",
    );
    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
  });
});
