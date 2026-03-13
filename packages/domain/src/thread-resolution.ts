import type { NormalizedCommand, TaskOperation } from "@channelpilot/shared-types";

const commandsRequiringActiveTask = new Set<TaskOperation>(["status", "steer", "stop", "resume", "summarize"]);

export interface TaskTargetResolution {
  taskId?: string;
  errorMessage?: string;
}

export function resolveTaskTarget(command: NormalizedCommand, activeMainTaskId: string | null): TaskTargetResolution {
  if (command.taskId) {
    return { taskId: command.taskId };
  }

  if (commandsRequiringActiveTask.has(command.op)) {
    if (!activeMainTaskId) {
      return {
        errorMessage: "当前 thread 没有进行中的主任务。请先创建任务，或显式提供 taskId。"
      };
    }

    return { taskId: activeMainTaskId };
  }

  if (command.op === "run" && activeMainTaskId) {
    return {
      errorMessage:
        "当前 thread 已有进行中的主任务。请使用 steer / stop / summarize，或等待当前任务结束后再创建新任务。"
    };
  }

  return {};
}
