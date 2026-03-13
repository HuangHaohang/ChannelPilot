import type { TaskEventType, TaskState } from "@channelpilot/shared-types";

export const terminalTaskStates = new Set<TaskState>(["completed", "failed", "cancelled"]);
export const activeMainTaskStates = new Set<TaskState>([
  "queued",
  "starting",
  "binding",
  "running",
  "waiting_input",
  "blocked",
  "summarizing",
  "lost",
  "cancelling"
]);

export const progressEligibleStates = new Set<TaskState>(["running", "waiting_input", "blocked", "summarizing"]);

export const terminalEventByState: Partial<Record<TaskState, TaskEventType>> = {
  completed: "TASK_COMPLETED",
  failed: "TASK_FAILED",
  cancelled: "TASK_CANCELLED",
  lost: "TASK_MARKED_LOST"
};
