import { assertValidTransition, canTransition } from "./state-machine.js";

describe("task state machine", () => {
  it("allows the documented lost exits", () => {
    expect(canTransition("lost", "running")).toBe(true);
    expect(canTransition("lost", "failed")).toBe(true);
    expect(canTransition("lost", "cancelled")).toBe(true);
    expect(canTransition("lost", "blocked")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(() => assertValidTransition("completed", "running")).toThrow(/非法状态迁移/);
  });
});
