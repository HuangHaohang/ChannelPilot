import { shouldMarkTaskLost } from "./reconcile-policy.js";

describe("reconcile lost policy", () => {
  it("does not mark task lost when session truth still exists", () => {
    expect(shouldMarkTaskLost("lost", true)).toBe(false);
  });

  it("marks task lost only when worker truth and session truth are both unavailable", () => {
    expect(shouldMarkTaskLost("lost", false)).toBe(true);
    expect(shouldMarkTaskLost("offline", false)).toBe(true);
    expect(shouldMarkTaskLost("idle", false)).toBe(false);
  });
});
