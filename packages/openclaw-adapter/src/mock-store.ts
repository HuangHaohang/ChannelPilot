import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

type MockSessionState = "starting" | "running" | "waiting_input" | "completed" | "failed" | "cancelled";

export interface MockSessionRecord {
  sessionId: string;
  sessionKey: string;
  threadKey: string;
  taskId: string;
  attemptId: string;
  repo?: string | undefined;
  prompt: string;
  state: MockSessionState;
  latestSummary: string | null;
  lastActivityAt: string;
  workerMetadata: Record<string, unknown>;
}

export interface MockReplyRecord {
  replyId: string;
  threadKey: string;
  taskId?: string | undefined;
  message: string;
  createdAt: string;
}

export interface MockOpenClawState {
  sessions: Record<string, MockSessionRecord>;
  bindings: Record<string, { sessionId: string; bindingKey: string; updatedAt: string }>;
  replies: MockReplyRecord[];
}

const emptyState: MockOpenClawState = {
  sessions: {},
  bindings: {},
  replies: []
};

export class FileBackedMockOpenClawStore {
  constructor(private readonly stateFile: string) {}

  async read(): Promise<MockOpenClawState> {
    try {
      return await this.readWithRetry();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.write(emptyState);
        return structuredClone(emptyState);
      }

      throw error;
    }
  }

  async write(state: MockOpenClawState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const tempFile = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tempFile, this.stateFile);
  }

  async mutate<T>(updater: (state: MockOpenClawState) => T | Promise<T>): Promise<T> {
    const state = await this.read();
    const result = await updater(state);
    await this.write(state);
    return result;
  }

  createReply(threadKey: string, message: string, taskId?: string): MockReplyRecord {
    return {
      replyId: randomUUID(),
      threadKey,
      taskId,
      message,
      createdAt: new Date().toISOString()
    };
  }

  private async readWithRetry(maxRetries = 3): Promise<MockOpenClawState> {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const contents = await fs.readFile(this.stateFile, "utf8");

      try {
        return JSON.parse(contents) as MockOpenClawState;
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        if (isLastAttempt || !(error instanceof SyntaxError)) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }

    throw new Error(`failed to read mock state file: ${this.stateFile}`);
  }
}
