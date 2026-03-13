import type { NotificationKind, TaskState } from "@channelpilot/shared-types";
import { progressEligibleStates } from "./constants.js";

export function buildNotificationDedupeKey(taskId: string, notificationKind: NotificationKind, stateVersion: bigint, summary?: string | null): string {
  const suffix = summary ? `:${summary.trim()}` : "";
  return `${taskId}:${notificationKind}:${stateVersion.toString()}${suffix}`;
}

export function shouldEmitProgressNotification(input: {
  state: TaskState;
  lastSummary: string | null;
  lastEmittedSummary: string | null;
  lastNotifiedAt: Date | null;
  now: Date;
  maxFrequencySeconds: number;
  force?: boolean;
}): boolean {
  if (input.force) {
    return true;
  }

  if (!progressEligibleStates.has(input.state)) {
    return false;
  }

  if (!input.lastSummary) {
    return false;
  }

  if (input.lastSummary === input.lastEmittedSummary) {
    return false;
  }

  if (!input.lastNotifiedAt) {
    return true;
  }

  return input.lastNotifiedAt.getTime() + input.maxFrequencySeconds * 1000 <= input.now.getTime();
}
