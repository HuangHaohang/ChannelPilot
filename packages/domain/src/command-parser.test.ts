import { normalizeCommand } from "./command-parser.js";

describe("normalizeCommand", () => {
  it("normalizes run commands from natural language", () => {
    const command = normalizeCommand({
      channel: "telegram",
      accountId: "acc-1",
      threadKey: "telegram:-100:topic:42",
      requesterId: "telegram:uid:123",
      sourceMessageId: "msg-1",
      text: "让 codex 在 repo payments 修复 CI 失败，不要动前端"
    });

    expect(command.op).toBe("run");
    expect(command.repo).toBe("payments");
    expect(command.backend).toBe("codex");
    expect(command.constraints).toContain("不要动前端");
  });

  it("routes summary and status-like queries correctly", () => {
    const command = normalizeCommand({
      channel: "telegram",
      accountId: "acc-1",
      threadKey: "telegram:-100:topic:42",
      requesterId: "telegram:uid:123",
      sourceMessageId: "msg-2",
      text: "总结一下刚才做了什么"
    });

    expect(command.op).toBe("summarize");
  });
});
