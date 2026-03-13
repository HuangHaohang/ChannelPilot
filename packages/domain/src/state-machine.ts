import type { TaskEventType, TaskState } from "@channelpilot/shared-types";
import { terminalEventByState } from "./constants.js";

const transitions: Record<TaskState, TaskState[]> = {
  queued: ["starting", "cancelled", "failed"],
  starting: ["binding", "failed", "lost", "cancelling"],
  binding: ["running", "failed", "lost", "cancelling"],
  running: ["waiting_input", "blocked", "summarizing", "failed", "lost", "cancelling"],
  waiting_input: ["running", "failed", "cancelling", "blocked"],
  blocked: ["running", "failed", "cancelling", "lost"],
  cancelling: ["cancelled", "failed", "lost"],
  summarizing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
  lost: ["running", "failed", "cancelled", "blocked"]
};

export interface StateTransitionInput {
  from: TaskState;
  to: TaskState;
  source: string;
  reason?: string | null;
  taskId: string;
  attemptId?: string | null;
}

export interface StateTransitionOutput {
  from: TaskState;
  to: TaskState;
  nextStateVersionIncrement: bigint;
  eventType: TaskEventType;
  source: string;
  reason?: string | null;
  taskId: string;
  attemptId?: string | null;
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return transitions[from].includes(to);
}

export function assertValidTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态迁移: ${from} -> ${to}`);
  }
}

export function createStateTransition(input: StateTransitionInput): StateTransitionOutput {
  assertValidTransition(input.from, input.to);

  return {
    ...input,
    eventType: terminalEventByState[input.to] ?? "STATE_TRANSITIONED",
    nextStateVersionIncrement: 1n
  };
}
