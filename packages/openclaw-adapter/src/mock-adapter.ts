import { randomUUID } from "node:crypto";
import type { OpenClawSessionSnapshot } from "@channelpilot/shared-types";
import { FileBackedMockOpenClawStore } from "./mock-store.js";
import type { BindingResult, OpenClawAdapter, SessionHandle, SpawnSessionInput, ThreadReplyInput } from "./openclaw-adapter.js";

export class MockOpenClawAdapter implements OpenClawAdapter {
  constructor(private readonly store: FileBackedMockOpenClawStore) {}

  async ensureThreadBinding(input: { threadKey: string; sessionHandle: SessionHandle }): Promise<BindingResult> {
    return this.store.mutate(async (state) => {
      const current = state.bindings[input.threadKey];
      if (current && current.sessionId === input.sessionHandle.sessionId) {
        return {
          bindingKey: current.bindingKey,
          sessionId: current.sessionId,
          threadKey: input.threadKey
        };
      }

      const bindingKey = randomUUID();
      state.bindings[input.threadKey] = {
        sessionId: input.sessionHandle.sessionId,
        bindingKey,
        updatedAt: new Date().toISOString()
      };

      return {
        bindingKey,
        sessionId: input.sessionHandle.sessionId,
        threadKey: input.threadKey
      };
    });
  }

  async spawnOrReuseSession(input: SpawnSessionInput): Promise<SessionHandle> {
    return this.store.mutate(async (state) => {
      const existingBinding = state.bindings[input.threadKey];
      if (existingBinding) {
        const existingSession = state.sessions[existingBinding.sessionId];
        if (existingSession && !["completed", "failed", "cancelled"].includes(existingSession.state)) {
          existingSession.lastActivityAt = new Date().toISOString();
          existingSession.prompt = input.prompt;
          existingSession.repo = input.repo;
          return {
            sessionId: existingSession.sessionId,
            sessionKey: existingSession.sessionKey
          };
        }
      }

      const sessionId = randomUUID();
      const sessionKey = randomUUID();
      state.sessions[sessionId] = {
        sessionId,
        sessionKey,
        threadKey: input.threadKey,
        taskId: input.taskId,
        attemptId: input.attemptId,
        repo: input.repo,
        prompt: input.prompt,
        state: "starting",
        latestSummary: "任务已创建，等待 worker 接手。",
        lastActivityAt: new Date().toISOString(),
        workerMetadata: {
          backend: input.backend,
          repo: input.repo ?? null
        }
      };

      return { sessionId, sessionKey };
    });
  }

  async steerSession(input: { sessionHandle: SessionHandle; text: string }): Promise<void> {
    await this.store.mutate(async (state) => {
      const session = state.sessions[input.sessionHandle.sessionId];
      if (!session) {
        throw new Error(`session 不存在: ${input.sessionHandle.sessionId}`);
      }

      session.latestSummary = `已接收追加指令：${input.text}`;
      session.lastActivityAt = new Date().toISOString();
      if (session.state === "waiting_input") {
        session.state = "running";
      }
    });
  }

  async cancelSession(input: { sessionHandle: SessionHandle; reason?: string }): Promise<void> {
    await this.store.mutate(async (state) => {
      const session = state.sessions[input.sessionHandle.sessionId];
      if (!session) {
        return;
      }

      session.state = "cancelled";
      session.latestSummary = input.reason ? `任务已取消：${input.reason}` : "任务已取消。";
      session.lastActivityAt = new Date().toISOString();
    });
  }

  async getSessionStatus(input: { sessionHandle: SessionHandle }): Promise<OpenClawSessionSnapshot> {
    const state = await this.store.read();
    const session = state.sessions[input.sessionHandle.sessionId];

    if (!session) {
      return {
        sessionExists: false,
        sessionState: "unknown",
        lastActivityAt: null,
        latestSummary: null
      };
    }

    return {
      sessionExists: true,
      sessionState: session.state,
      lastActivityAt: session.lastActivityAt,
      latestSummary: session.latestSummary,
      workerMetadata: session.workerMetadata
    };
  }

  async postThreadReply(input: ThreadReplyInput): Promise<void> {
    await this.store.mutate(async (state) => {
      state.replies.push(this.store.createReply(input.threadKey, input.message, input.taskId));
    });
  }
}
