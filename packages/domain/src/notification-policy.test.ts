import { buildNotificationDedupeKey, shouldEmitProgressNotification } from "./notification-policy.js";

describe("notification policy", () => {
  it("builds a deterministic outbox dedupe key", () => {
    expect(buildNotificationDedupeKey("T-1", "progress", 3n, "summary")).toBe("T-1:progress:3:summary");
  });

  it("throttles duplicate progress summaries", () => {
    const allowed = shouldEmitProgressNotification({
      state: "running",
      lastSummary: "new summary",
      lastEmittedSummary: "old summary",
      lastNotifiedAt: new Date("2026-03-14T00:00:00Z"),
      now: new Date("2026-03-14T00:10:00Z"),
      maxFrequencySeconds: 300
    });
    const blocked = shouldEmitProgressNotification({
      state: "running",
      lastSummary: "same summary",
      lastEmittedSummary: "same summary",
      lastNotifiedAt: new Date("2026-03-14T00:10:00Z"),
      now: new Date("2026-03-14T00:10:10Z"),
      maxFrequencySeconds: 300
    });

    expect(allowed).toBe(true);
    expect(blocked).toBe(false);
  });
});
