import type { OpenClawSessionSnapshot } from "@channelpilot/shared-types";

export interface SessionHandle {
  sessionId: string;
  sessionKey: string;
}

export interface BindingResult {
  bindingKey: string;
  threadKey: string;
  sessionId: string;
}

export interface SpawnSessionInput {
  threadKey: string;
  backend: "codex";
  repo?: string | undefined;
  prompt: string;
  taskId: string;
  attemptId: string;
}

export interface ThreadReplyInput {
  threadKey: string;
  message: string;
  taskId?: string;
}

export interface OpenClawAdapter {
  ensureThreadBinding(input: { threadKey: string; sessionHandle: SessionHandle }): Promise<BindingResult>;
  spawnOrReuseSession(input: SpawnSessionInput): Promise<SessionHandle>;
  steerSession(input: { sessionHandle: SessionHandle; text: string }): Promise<void>;
  cancelSession(input: { sessionHandle: SessionHandle; reason?: string }): Promise<void>;
  getSessionStatus(input: { sessionHandle: SessionHandle }): Promise<OpenClawSessionSnapshot>;
  postThreadReply(input: ThreadReplyInput): Promise<void>;
}
