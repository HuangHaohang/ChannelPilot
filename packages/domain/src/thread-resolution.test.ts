import { resolveTaskTarget } from "./thread-resolution.js";

const baseCommand = {
  backend: "codex" as const,
  threadKey: "telegram:-100:topic:42",
  requesterId: "telegram:uid:123",
  idempotencyKey: "idem-1",
  sourceMessageId: "msg-1",
  constraints: [],
  rawText: ""
};

describe("resolveTaskTarget", () => {
  it("defaults status-like commands to the active main task", () => {
    const result = resolveTaskTarget(
      {
        ...baseCommand,
        op: "status",
        rawText: "状态"
      },
      "T-20260314-00001"
    );

    expect(result.taskId).toBe("T-20260314-00001");
  });

  it("rejects creating a second active main task in the same thread", () => {
    const result = resolveTaskTarget(
      {
        ...baseCommand,
        op: "run",
        goal: "fix tests",
        rawText: "让 codex 修 bug"
      },
      "T-20260314-00001"
    );

    expect(result.errorMessage).toContain("当前 thread 已有进行中的主任务");
  });
});
