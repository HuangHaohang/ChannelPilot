import type { WorkerStatus } from "@channelpilot/shared-types";

export function shouldMarkTaskLost(workerStatus: WorkerStatus | null, sessionExists: boolean): boolean {
  if (sessionExists) {
    return false;
  }

  return workerStatus === null || workerStatus === "offline" || workerStatus === "lost";
}
