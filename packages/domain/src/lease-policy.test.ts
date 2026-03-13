import { canRenewLease, isLeaseExpired } from "./lease-policy.js";

describe("lease policy", () => {
  it("detects expired leases", () => {
    expect(isLeaseExpired(new Date("2026-03-14T00:00:00Z"), new Date("2026-03-14T00:00:01Z"))).toBe(true);
  });

  it("only renews when owner and token still match", () => {
    expect(
      canRenewLease(
        {
          leaseOwner: "api-1",
          leaseToken: "token-1",
          leaseUntil: new Date("2026-03-14T00:05:00Z")
        },
        "api-1",
        "token-1",
        new Date("2026-03-14T00:04:00Z")
      )
    ).toBe(true);

    expect(
      canRenewLease(
        {
          leaseOwner: "api-1",
          leaseToken: "token-1",
          leaseUntil: new Date("2026-03-14T00:05:00Z")
        },
        "api-2",
        "token-1",
        new Date("2026-03-14T00:04:00Z")
      )
    ).toBe(false);
  });
});
