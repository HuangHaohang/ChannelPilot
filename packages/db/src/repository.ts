import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, NotificationStatus, TaskEventType, TaskState, WorkerStatus } from "@prisma/client";
import { canResumePublicState, canSteerPublicState, canStopPublicState, toPublicTaskState } from "@channelpilot/domain";
import type {
  IngestChannelMessageInput,
  NormalizedCommand,
  NotificationKind,
  NotificationPayload,
  OperatorMessageResponse,
  ThreadView,
  WorkerDescriptor
} from "@channelpilot/shared-types";
import { createPrismaClient } from "./client.js";

const activeMainTaskStates = [
  "queued",
  "starting",
  "binding",
  "running",
  "waiting_input",
  "blocked",
  "summarizing",
  "lost",
  "cancelling"
] satisfies TaskState[];

export interface CreateTaskBundleInput {
  taskId: string;
  attemptId: string;
  channel: string;
  accountId: string;
  title: string;
  requestedGoal: string;
  requesterId: string;
  threadKey: string;
  repo?: string | undefined;
  cwd?: string | undefined;
  command: NormalizedCommand;
  rawMessage: IngestChannelMessageInput;
  idempotentResponse: OperatorMessageResponse;
}

export interface TransitionTaskStateInput {
  taskId: string;
  expectedStateVersion: bigint;
  nextState: TaskState;
  source: string;
  reason?: string | null | undefined;
  attemptId?: string | null | undefined;
  attemptState?: Prisma.TaskAttemptUpdateInput["attemptState"];
  attemptEndedAt?: Date | null;
  payloadJson?: Prisma.InputJsonValue;
  desiredState?: Prisma.TaskUpdateInput["desiredState"];
  lastSummary?: string | null;
  completedAt?: Date | null;
}

export interface LeaseResult {
  taskId: string;
  leaseOwner: string;
  leaseToken: string;
  leaseUntil: Date;
  heartbeatAt: Date;
}

export class ChannelPilotRepository {
  constructor(private readonly prisma: PrismaClient = createPrismaClient()) {}

  get client(): PrismaClient {
    return this.prisma;
  }

  async findIdempotencyRecord(idempotencyKey: string, requesterId: string, threadKey: string) {
    return this.prisma.ingestIdempotency.findUnique({
      where: {
        idempotencyKey_requesterId_threadKey: {
          idempotencyKey,
          requesterId,
          threadKey
        }
      }
    });
  }

  async getTaskById(taskId: string) {
    return this.prisma.task.findUnique({
      where: { taskId },
      include: {
        attempts: {
          orderBy: { startedAt: "desc" },
          take: 1
        }
      }
    });
  }

  async getAttemptById(attemptId: string) {
    return this.prisma.taskAttempt.findUnique({
      where: { attemptId }
    });
  }

  async getCurrentActiveMainTask(threadKey: string) {
    return this.prisma.task.findFirst({
      where: {
        threadKey,
        taskKind: "main",
        state: { in: activeMainTaskStates }
      },
      orderBy: { createdAt: "desc" }
    });
  }

  async getThreadView(threadKey: string): Promise<ThreadView> {
    const task = await this.getCurrentActiveMainTask(threadKey);

    if (!task) {
      return {
        threadKey,
        currentTaskId: null,
        publicState: null,
        lastSummary: null,
        canSteer: false,
        canStop: false,
        canResume: false
      };
    }

    return {
      threadKey,
      currentTaskId: task.taskId,
      publicState: toPublicTaskState(task.state),
      lastSummary: task.lastSummary,
      canSteer: canSteerPublicState(task.state),
      canStop: canStopPublicState(task.state),
      canResume: canResumePublicState(task.state)
    };
  }

  async createTaskBundle(input: CreateTaskBundleInput) {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          taskId: input.taskId,
          title: input.title,
          requestedGoal: input.requestedGoal,
          backend: "codex",
          state: "queued",
          desiredState: "none",
          stateVersion: 0n,
          requesterId: input.requesterId,
          channel: input.channel,
          accountId: input.accountId,
          threadKey: input.threadKey,
          taskKind: "main",
          createdAt: now,
          updatedAt: now,
          ...(input.repo !== undefined ? { repo: input.repo } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {})
        }
      });

      const attempt = await tx.taskAttempt.create({
        data: {
          attemptId: input.attemptId,
          taskId: input.taskId,
          workerType: "codex",
          attemptState: "created",
          assignmentMetadataJson: {
            assignmentMode: "contract-first"
          },
          startedAt: now
        }
      });

      await tx.task.update({
        where: { taskId: input.taskId },
        data: {
          currentAttemptId: input.attemptId,
          updatedAt: now
        }
      });

      await tx.openClawThread.upsert({
        where: { threadKey: input.threadKey },
        create: {
          threadKey: input.threadKey,
          channel: input.channel,
          accountId: input.accountId,
          currentTaskId: input.taskId,
          createdAt: now,
          updatedAt: now
        },
        update: {
          currentTaskId: input.taskId,
          updatedAt: now
        }
      });

      await tx.taskEvent.createMany({
        data: [
          {
            taskId: input.taskId,
            attemptId: input.attemptId,
            eventType: TaskEventType.TASK_CREATED,
            source: "task_service",
            reason: "task created",
            payloadJson: {
              requestedGoal: input.requestedGoal
            },
            createdAt: now
          },
          {
            taskId: input.taskId,
            attemptId: input.attemptId,
            eventType: TaskEventType.COMMAND_NORMALIZED,
            source: "command_parser",
            reason: null,
            payloadJson: input.command as unknown as Prisma.InputJsonValue,
            createdAt: now
          },
          {
            taskId: input.taskId,
            attemptId: input.attemptId,
            eventType: TaskEventType.TASK_ACCEPTED,
            source: "task_service",
            reason: "task accepted",
            payloadJson: {
              idempotencyKey: input.command.idempotencyKey
            },
            createdAt: now
          }
        ]
      });

      await tx.inboundMessage.create({
        data: {
          messageId: randomUUID(),
          channel: input.channel,
          accountId: input.accountId,
          threadKey: input.threadKey,
          requesterId: input.requesterId,
          sourceMessageId: input.rawMessage.sourceMessageId,
          rawPayloadJson: input.rawMessage as unknown as Prisma.InputJsonValue,
          normalizedCommandJson: input.command as unknown as Prisma.InputJsonValue,
          idempotencyKey: input.command.idempotencyKey,
          taskId: input.taskId,
          processingResult: "accepted",
          processedAt: now,
          createdAt: now
        }
      });

      await tx.ingestIdempotency.create({
        data: {
          recordId: randomUUID(),
          idempotencyKey: input.command.idempotencyKey,
          requesterId: input.requesterId,
          threadKey: input.threadKey,
          taskId: input.taskId,
          responseJson: input.idempotentResponse as unknown as Prisma.InputJsonValue,
          createdAt: now,
          updatedAt: now
        }
      });

      await tx.auditLog.create({
        data: {
          actorId: input.requesterId,
          action: "task.create",
          targetType: "task",
          targetId: input.taskId,
          payloadJson: {
            threadKey: input.threadKey,
            sourceMessageId: input.rawMessage.sourceMessageId
          },
          createdAt: now
        }
      });

      return { task, attempt };
    });
  }

  async recordNonTaskInboundMessage(input: {
    channel: string;
    accountId: string;
    threadKey: string;
    requesterId: string;
    sourceMessageId: string;
    rawPayloadJson: Prisma.InputJsonValue;
    normalizedCommandJson: Prisma.InputJsonValue;
    idempotencyKey: string;
    processingResult: string;
  }) {
    return this.prisma.inboundMessage.create({
      data: {
        messageId: randomUUID(),
        ...input,
        processedAt: new Date(),
        createdAt: new Date()
      }
    });
  }

  async persistIdempotentResponse(input: {
    idempotencyKey: string;
    requesterId: string;
    threadKey: string;
    taskId?: string | undefined;
    response: OperatorMessageResponse;
  }) {
    return this.prisma.ingestIdempotency.upsert({
      where: {
        idempotencyKey_requesterId_threadKey: {
          idempotencyKey: input.idempotencyKey,
          requesterId: input.requesterId,
          threadKey: input.threadKey
        }
      },
      create: {
        recordId: randomUUID(),
        idempotencyKey: input.idempotencyKey,
        requesterId: input.requesterId,
        threadKey: input.threadKey,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        responseJson: input.response as unknown as Prisma.InputJsonValue,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      update: {
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        responseJson: input.response as unknown as Prisma.InputJsonValue,
        updatedAt: new Date()
      }
    });
  }

  async appendAuditLog(input: {
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    payloadJson?: Prisma.InputJsonValue;
  }) {
    return this.prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        payloadJson: input.payloadJson ?? {},
        createdAt: new Date()
      }
    });
  }

  async appendTaskEvent(input: {
    taskId: string;
    attemptId?: string | null;
    eventType: TaskEventType;
    source: string;
    reason?: string | null;
    payloadJson?: Prisma.InputJsonValue;
  }) {
    return this.prisma.taskEvent.create({
      data: {
        taskId: input.taskId,
        eventType: input.eventType,
        source: input.source,
        payloadJson: input.payloadJson ?? {},
        createdAt: new Date(),
        ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {})
      }
    });
  }

  async transitionTaskState(input: TransitionTaskStateInput) {
    const reason = input.reason ?? null;
    const payload = input.payloadJson ?? {};
    const now = new Date();
    const nextState = input.nextState;
    const completedAt = input.completedAt ?? null;
    const attemptEndedAt = input.attemptEndedAt;

    return this.prisma.$transaction(async (tx) => {
      if (input.attemptId && (input.attemptState !== undefined || attemptEndedAt !== undefined)) {
        await tx.taskAttempt.update({
          where: { attemptId: input.attemptId },
          data: {
            ...(input.attemptState !== undefined ? { attemptState: input.attemptState } : {}),
            ...(attemptEndedAt !== undefined ? { endedAt: attemptEndedAt } : {})
          }
        });
      }

      const updatedRows = await tx.$queryRaw<Array<{ task_id: string; state_version: bigint }>>`
        UPDATE "tasks"
        SET
          "state" = CAST(${nextState} AS "TaskState"),
          "desired_state" = COALESCE(CAST(${input.desiredState ?? null} AS "TaskDesiredState"), "desired_state"),
          "last_summary" = COALESCE(${input.lastSummary ?? null}, "last_summary"),
          "completed_at" = COALESCE(${completedAt}, "completed_at"),
          "state_version" = "state_version" + 1,
          "updated_at" = ${now}
        WHERE "task_id" = ${input.taskId}
          AND "state_version" = ${input.expectedStateVersion}
        RETURNING "task_id", "state_version"
      `;

      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(`task state transition optimistic lock failed: ${input.taskId}`);
      }

      await tx.taskEvent.create({
        data: {
          taskId: input.taskId,
          eventType: nextState === "completed"
            ? TaskEventType.TASK_COMPLETED
            : nextState === "failed"
              ? TaskEventType.TASK_FAILED
              : nextState === "cancelled"
                ? TaskEventType.TASK_CANCELLED
                : nextState === "lost"
                  ? TaskEventType.TASK_MARKED_LOST
                  : TaskEventType.STATE_TRANSITIONED,
          source: input.source,
          reason,
          payloadJson: payload,
          createdAt: now,
          ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {})
        }
      });

      if (["completed", "failed", "cancelled"].includes(nextState)) {
        await tx.openClawThread.updateMany({
          where: {
            currentTaskId: input.taskId
          },
          data: {
            currentTaskId: null,
            updatedAt: now
          }
        });
      }

      return updated.state_version;
    });
  }

  async updateAttempt(input: {
    attemptId: string;
    attemptState?: Prisma.TaskAttemptUpdateInput["attemptState"];
    workerHost?: string | null;
    acpSessionId?: string | null;
    acpSessionKey?: string | null;
    bindingKey?: string | null;
    assignedWorkerId?: string | null;
    assignmentMetadataJson?: Prisma.InputJsonValue;
    exitCode?: number | null;
    resultJson?: Prisma.InputJsonValue;
    endedAt?: Date | null;
  }) {
    return this.prisma.taskAttempt.update({
      where: { attemptId: input.attemptId },
      data: {
        ...(input.attemptState !== undefined ? { attemptState: input.attemptState } : {}),
        ...(input.workerHost !== undefined ? { workerHost: input.workerHost } : {}),
        ...(input.acpSessionId !== undefined ? { acpSessionId: input.acpSessionId } : {}),
        ...(input.acpSessionKey !== undefined ? { acpSessionKey: input.acpSessionKey } : {}),
        ...(input.bindingKey !== undefined ? { bindingKey: input.bindingKey } : {}),
        ...(input.assignedWorkerId !== undefined ? { assignedWorkerId: input.assignedWorkerId } : {}),
        ...(input.assignmentMetadataJson !== undefined ? { assignmentMetadataJson: input.assignmentMetadataJson } : {}),
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        ...(input.resultJson !== undefined ? { resultJson: input.resultJson } : {}),
        ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {})
      }
    });
  }

  async updateTaskSnapshot(input: {
    taskId: string;
    lastSummary?: string | null;
    lastEmittedSummary?: string | null;
    lastNotifiedAt?: Date | null;
    desiredState?: Prisma.TaskUpdateInput["desiredState"];
  }) {
    return this.prisma.task.update({
      where: { taskId: input.taskId },
      data: {
        updatedAt: new Date(),
        ...(input.lastSummary !== undefined ? { lastSummary: input.lastSummary } : {}),
        ...(input.lastEmittedSummary !== undefined ? { lastEmittedSummary: input.lastEmittedSummary } : {}),
        ...(input.lastNotifiedAt !== undefined ? { lastNotifiedAt: input.lastNotifiedAt } : {}),
        ...(input.desiredState !== undefined ? { desiredState: input.desiredState } : {})
      }
    });
  }

  async findWorkerById(workerId: string) {
    return this.prisma.worker.findUnique({
      where: { workerId }
    });
  }

  async findAttemptsByWorker(workerId: string) {
    return this.prisma.taskAttempt.findMany({
      where: { assignedWorkerId: workerId }
    });
  }

  async enqueueNotification(input: {
    taskId: string;
    threadKey: string;
    notificationKind: NotificationKind;
    dedupeKey: string;
    payload: NotificationPayload;
    stateVersion: bigint;
    nextAttemptAt?: Date;
  }) {
    const now = new Date();

    return this.prisma.notificationOutbox.upsert({
      where: { dedupeKey: input.dedupeKey },
      create: {
        notificationId: randomUUID(),
        taskId: input.taskId,
        threadKey: input.threadKey,
        notificationKind: input.notificationKind,
        status: NotificationStatus.pending,
        dedupeKey: input.dedupeKey,
        attemptCount: 0,
        nextAttemptAt: input.nextAttemptAt ?? now,
        payloadJson: input.payload as unknown as Prisma.InputJsonValue,
        stateVersion: input.stateVersion,
        createdAt: now,
        updatedAt: now
      },
      update: {}
    });
  }

  async claimNotifications(limit: number, claimedBy: string) {
    return this.prisma.$queryRaw<Array<{
      notification_id: string;
      task_id: string;
      thread_key: string;
      notification_kind: string;
      payload_json: Prisma.JsonValue;
      state_version: bigint;
      attempt_count: number;
    }>>`
      WITH candidates AS (
        SELECT "notification_id"
        FROM "notification_outbox"
        WHERE "status" IN ('pending', 'failed')
          AND "next_attempt_at" <= NOW()
        ORDER BY "next_attempt_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE "notification_outbox" AS outbox
      SET
        "status" = 'delivering',
        "claimed_by" = ${claimedBy},
        "claimed_at" = NOW(),
        "updated_at" = NOW()
      FROM candidates
      WHERE outbox."notification_id" = candidates."notification_id"
      RETURNING
        outbox."notification_id",
        outbox."task_id",
        outbox."thread_key",
        outbox."notification_kind",
        outbox."payload_json",
        outbox."state_version",
        outbox."attempt_count"
    `;
  }

  async markNotificationDelivered(notificationId: string) {
    const now = new Date();
    return this.prisma.notificationOutbox.update({
      where: { notificationId },
      data: {
        status: NotificationStatus.delivered,
        deliveredAt: now,
        updatedAt: now
      }
    });
  }

  async markNotificationFailed(notificationId: string, lastError: string, delaySeconds: number, deadLetterAfter = 5) {
    const current = await this.prisma.notificationOutbox.findUnique({
      where: { notificationId }
    });

    if (!current) {
      return null;
    }

    const attemptCount = current.attemptCount + 1;
    const nextStatus = attemptCount >= deadLetterAfter ? NotificationStatus.dead_letter : NotificationStatus.failed;

    return this.prisma.notificationOutbox.update({
      where: { notificationId },
      data: {
        status: nextStatus,
        attemptCount,
        lastError,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
        updatedAt: new Date()
      }
    });
  }

  async listWorkers(): Promise<WorkerDescriptor[]> {
    const workers = await this.prisma.worker.findMany({
      orderBy: { lastSeenAt: "desc" }
    });

    return workers.map((worker) => ({
      workerId: worker.workerId,
      label: worker.label,
      host: worker.host,
      status: worker.status,
      capabilities: worker.capabilitiesJson as Record<string, unknown>,
      metadata: worker.metadataJson as Record<string, unknown>,
      lastSeenAt: worker.lastSeenAt.toISOString()
    }));
  }

  async upsertWorker(input: {
    workerId: string;
    label: string;
    host: string;
    capabilitiesJson: Prisma.InputJsonValue;
    metadataJson?: Prisma.InputJsonValue;
    status?: WorkerStatus;
  }) {
    const now = new Date();
    return this.prisma.worker.upsert({
      where: { workerId: input.workerId },
      create: {
        workerId: input.workerId,
        label: input.label,
        host: input.host,
        capabilitiesJson: input.capabilitiesJson,
        metadataJson: input.metadataJson ?? {},
        status: input.status ?? WorkerStatus.idle,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now
      },
      update: {
        label: input.label,
        host: input.host,
        capabilitiesJson: input.capabilitiesJson,
        metadataJson: input.metadataJson ?? {},
        status: input.status ?? WorkerStatus.idle,
        lastSeenAt: now,
        updatedAt: now
      }
    });
  }

  async heartbeatWorker(workerId: string, status?: WorkerStatus, metadataJson?: Prisma.InputJsonValue) {
    return this.prisma.worker.update({
      where: { workerId },
      data: {
        lastSeenAt: new Date(),
        updatedAt: new Date(),
        ...(status !== undefined ? { status } : {}),
        ...(metadataJson !== undefined ? { metadataJson } : {})
      }
    });
  }

  async assignAttemptToWorker(input: {
    attemptId: string;
    workerId: string;
    metadata: Prisma.InputJsonValue;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await tx.taskAttempt.update({
        where: { attemptId: input.attemptId },
        data: {
          assignedWorkerId: input.workerId,
          attemptState: "assigned",
          assignmentMetadataJson: input.metadata
        }
      });

      await tx.taskEvent.create({
        data: {
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
          eventType: TaskEventType.WORKER_ASSIGNED,
          source: "worker_registry",
          reason: "attempt assigned to worker",
          payloadJson: {
            workerId: input.workerId
          },
          createdAt: new Date()
        }
      });

      return attempt;
    });
  }

  async detectLostWorkers(cutoff: Date) {
    const workers = await this.prisma.worker.findMany({
      where: {
        lastSeenAt: { lt: cutoff },
        status: { not: WorkerStatus.lost }
      }
    });

    const updated = await this.prisma.worker.updateMany({
      where: {
        workerId: { in: workers.map((worker) => worker.workerId) }
      },
      data: {
        status: WorkerStatus.lost,
        updatedAt: new Date()
      }
    });

    return {
      affectedWorkers: workers,
      count: updated.count
    };
  }

  async listReconcileCandidates(cutoff: Date) {
    return this.prisma.task.findMany({
      where: {
        state: {
          in: ["starting", "binding", "running", "waiting_input", "blocked", "summarizing", "cancelling", "lost"]
        },
        updatedAt: { lt: cutoff }
      },
      orderBy: { updatedAt: "asc" }
    });
  }

  async acquireLease(taskId: string, leaseOwner: string, leaseToken: string, leaseSeconds: number): Promise<LeaseResult | null> {
    const rows = await this.prisma.$queryRaw<Array<LeaseResult>>`
      INSERT INTO "task_leases" ("task_id", "lease_owner", "lease_token", "lease_until", "heartbeat_at")
      VALUES (${taskId}, ${leaseOwner}, ${leaseToken}, NOW() + (${leaseSeconds} || ' seconds')::interval, NOW())
      ON CONFLICT ("task_id")
      DO UPDATE SET
        "lease_owner" = EXCLUDED."lease_owner",
        "lease_token" = EXCLUDED."lease_token",
        "lease_until" = EXCLUDED."lease_until",
        "heartbeat_at" = EXCLUDED."heartbeat_at"
      WHERE "task_leases"."lease_until" <= NOW()
      RETURNING
        "task_id" AS "taskId",
        "lease_owner" AS "leaseOwner",
        "lease_token" AS "leaseToken",
        "lease_until" AS "leaseUntil",
        "heartbeat_at" AS "heartbeatAt"
    `;

    return rows[0] ?? null;
  }

  async renewLease(taskId: string, leaseOwner: string, leaseToken: string, leaseSeconds: number): Promise<LeaseResult | null> {
    const rows = await this.prisma.$queryRaw<Array<LeaseResult>>`
      UPDATE "task_leases"
      SET
        "lease_until" = NOW() + (${leaseSeconds} || ' seconds')::interval,
        "heartbeat_at" = NOW()
      WHERE "task_id" = ${taskId}
        AND "lease_owner" = ${leaseOwner}
        AND "lease_token" = ${leaseToken}
        AND "lease_until" > NOW()
      RETURNING
        "task_id" AS "taskId",
        "lease_owner" AS "leaseOwner",
        "lease_token" AS "leaseToken",
        "lease_until" AS "leaseUntil",
        "heartbeat_at" AS "heartbeatAt"
    `;

    return rows[0] ?? null;
  }

  async releaseLease(taskId: string, leaseOwner: string, leaseToken: string): Promise<boolean> {
    const deleted = await this.prisma.taskLease.deleteMany({
      where: {
        taskId,
        leaseOwner,
        leaseToken
      }
    });

    return deleted.count > 0;
  }
}
