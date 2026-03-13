import { randomInt, randomUUID } from "node:crypto";

export function createTaskId(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const suffix = String(randomInt(0, 100000)).padStart(5, "0");
  return `T-${y}${m}${d}-${suffix}`;
}

export function createAttemptId(): string {
  return `ATT-${randomUUID()}`;
}

export function createLeaseToken(): string {
  return randomUUID();
}
