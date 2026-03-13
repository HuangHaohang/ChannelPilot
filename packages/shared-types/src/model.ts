export const taskStates = [
  "queued",
  "starting",
  "binding",
  "running",
  "waiting_input",
  "blocked",
  "cancelling",
  "summarizing",
  "completed",
  "failed",
  "cancelled",
  "lost"
] as const;

export const publicTaskStates = [
  "queued",
  "starting",
  "binding",
  "running",
  "waiting_input",
  "blocked",
  "summarizing",
  "completed",
  "failed",
  "cancelled",
  "lost"
] as const;

export const taskDesiredStates = ["none", "running", "cancelled", "blocked"] as const;
export const taskKinds = ["main", "follow_up"] as const;
export const taskOperations = ["run", "status", "steer", "stop", "resume", "summarize", "help"] as const;
export const attemptStates = [
  "created",
  "assigned",
  "accepted",
  "running",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
  "lost"
] as const;
export const workerStatuses = ["idle", "busy", "offline", "lost"] as const;
export const notificationStatuses = ["pending", "delivering", "delivered", "failed", "dead_letter"] as const;
export const notificationKinds = ["receipt", "progress", "waiting_input", "final", "system"] as const;
export const taskEventTypes = [
  "TASK_CREATED",
  "COMMAND_NORMALIZED",
  "TASK_ACCEPTED",
  "STATE_TRANSITIONED",
  "THREAD_BOUND",
  "SESSION_SPAWNED",
  "SESSION_REUSED",
  "SESSION_STATUS_SYNCED",
  "STEER_ACCEPTED",
  "STOP_REQUESTED",
  "RESUME_REQUESTED",
  "WORKER_ASSIGNED",
  "WORKER_HEARTBEAT_RECORDED",
  "WORKER_MARKED_LOST",
  "NOTIFICATION_ENQUEUED",
  "NOTIFICATION_DELIVERED",
  "NOTIFICATION_FAILED",
  "RECONCILIATION_APPLIED",
  "TASK_MARKED_LOST",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_CANCELLED"
] as const;

export type TaskState = (typeof taskStates)[number];
export type PublicTaskState = (typeof publicTaskStates)[number];
export type TaskDesiredState = (typeof taskDesiredStates)[number];
export type TaskKind = (typeof taskKinds)[number];
export type TaskOperation = (typeof taskOperations)[number];
export type AttemptState = (typeof attemptStates)[number];
export type WorkerStatus = (typeof workerStatuses)[number];
export type NotificationStatus = (typeof notificationStatuses)[number];
export type NotificationKind = (typeof notificationKinds)[number];
export type TaskEventType = (typeof taskEventTypes)[number];

export interface WorkerCapabilities {
  repos?: string[];
  supportsResume?: boolean;
  supportsSteer?: boolean;
  labels?: string[];
  [key: string]: unknown;
}

export interface WorkerMetadata {
  os?: string;
  arch?: string;
  version?: string;
  mockState?: "idle" | "busy" | "offline";
  [key: string]: unknown;
}

export interface WorkerDescriptor {
  workerId: string;
  label: string;
  host: string;
  status: WorkerStatus;
  capabilities: WorkerCapabilities;
  metadata?: WorkerMetadata;
  lastSeenAt: string;
}

export interface NormalizedCommand {
  op: TaskOperation;
  backend: "codex";
  goal?: string | undefined;
  repo?: string | undefined;
  taskId?: string | undefined;
  threadKey: string;
  requesterId: string;
  idempotencyKey: string;
  sourceMessageId: string;
  constraints: string[];
  rawText: string;
}

export interface IngestChannelMessageInput {
  channel: string;
  accountId: string;
  threadKey: string;
  requesterId: string;
  sourceMessageId: string;
  text: string;
  idempotencyKey?: string;
}

export interface ThreadView {
  threadKey: string;
  currentTaskId: string | null;
  publicState: PublicTaskState | null;
  lastSummary: string | null;
  canSteer: boolean;
  canStop: boolean;
  canResume: boolean;
}

export interface OperatorMessageResponse {
  accepted: boolean;
  taskId?: string | undefined;
  state?: PublicTaskState | undefined;
  messageForOperator: string;
}

export interface TaskSummarySnapshot {
  taskId: string;
  state: TaskState;
  publicState: PublicTaskState;
  desiredState: TaskDesiredState;
  stateVersion: bigint;
  threadKey: string;
  lastSummary: string | null;
  currentAttemptId: string | null;
}

export interface NotificationPayload {
  message: string;
  taskId: string;
  threadKey: string;
  stateVersion: string;
  notificationKind: NotificationKind;
}

export interface OpenClawSessionSnapshot {
  sessionExists: boolean;
  sessionState: "starting" | "running" | "waiting_input" | "completed" | "failed" | "cancelled" | "unknown";
  lastActivityAt: string | null;
  latestSummary: string | null;
  workerMetadata?: Record<string, unknown>;
}
