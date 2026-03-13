import "dotenv/config";
import pino from "pino";
import { buildNotificationDedupeKey, canTransition, shouldMarkTaskLost, toPublicStateLabel } from "@channelpilot/domain";
import { ChannelPilotRepository, createLeaseToken } from "@channelpilot/db";
import { FileBackedMockOpenClawStore, MockOpenClawAdapter } from "@channelpilot/openclaw-adapter";
import { loadRuntimeConfig } from "@channelpilot/shared-types";

const config = loadRuntimeConfig(process.env);
const logger = pino({ level: config.LOG_LEVEL });
const repository = new ChannelPilotRepository();
const adapter = new MockOpenClawAdapter(new FileBackedMockOpenClawStore(config.MOCK_OPENCLAW_STATE_FILE));

async function reconcileTask(taskId: string) {
  const token = createLeaseToken();
  const lease = await repository.acquireLease(taskId, `reconciler:${process.pid}`, token, config.LEASE_SECONDS);
  if (!lease) {
    return;
  }

  try {
    const task = await repository.getTaskById(taskId);
    if (!task) {
      return;
    }

    const attempt = task.currentAttemptId ? await repository.getAttemptById(task.currentAttemptId) : task.attempts[0] ?? null;
    const attemptId = attempt?.attemptId ?? null;
    const worker = attempt?.assignedWorkerId ? await repository.findWorkerById(attempt.assignedWorkerId) : null;
    const sessionHandle = attempt?.acpSessionId && attempt.acpSessionKey
      ? { sessionId: attempt.acpSessionId, sessionKey: attempt.acpSessionKey }
      : null;
    const snapshot = sessionHandle ? await adapter.getSessionStatus({ sessionHandle }) : null;

    if (snapshot?.latestSummary && snapshot.latestSummary !== task.lastSummary) {
      await repository.updateTaskSnapshot({
        taskId: task.taskId,
        lastSummary: snapshot.latestSummary
      });
    }

    if (snapshot?.sessionExists) {
      if (snapshot.sessionState === "running" && task.state === "lost" && canTransition("lost", "running")) {
        const version = await repository.transitionTaskState({
          taskId: task.taskId,
          expectedStateVersion: task.stateVersion,
          nextState: "running",
          source: "reconciler",
          reason: "session recovered from lost",
          attemptId
        });
        await repository.enqueueNotification({
          taskId: task.taskId,
          threadKey: task.threadKey,
          notificationKind: "progress",
          dedupeKey: buildNotificationDedupeKey(task.taskId, "progress", version, "recovered"),
          payload: {
            taskId: task.taskId,
            threadKey: task.threadKey,
            notificationKind: "progress",
            stateVersion: version.toString(),
            message: `任务 ${task.taskId}\n当前状态：${toPublicStateLabel("running")}\n摘要：reconciler 已确认任务恢复。`
          },
          stateVersion: version
        });
      } else if (snapshot.sessionState === "waiting_input" && task.state !== "waiting_input" && canTransition(task.state, "waiting_input")) {
        await repository.transitionTaskState({
          taskId: task.taskId,
          expectedStateVersion: task.stateVersion,
          nextState: "waiting_input",
          source: "reconciler",
          reason: "session requires operator input",
          attemptId,
          lastSummary: snapshot.latestSummary ?? task.lastSummary
        });
      } else if (snapshot.sessionState === "completed" && canTransition(task.state, "summarizing")) {
        const summarizingVersion = await repository.transitionTaskState({
          taskId: task.taskId,
          expectedStateVersion: task.stateVersion,
          nextState: "summarizing",
          source: "reconciler",
          reason: "session completed, finalizing",
          attemptId,
          lastSummary: snapshot.latestSummary ?? task.lastSummary
        });
        await repository.transitionTaskState({
          taskId: task.taskId,
          expectedStateVersion: summarizingVersion,
          nextState: "completed",
          source: "reconciler",
          reason: "reconciler finalized completed session",
          attemptId,
          lastSummary: snapshot.latestSummary ?? task.lastSummary,
          completedAt: new Date()
        });
      } else if (snapshot.sessionState === "failed" && canTransition(task.state, "failed")) {
        await repository.transitionTaskState({
          taskId: task.taskId,
          expectedStateVersion: task.stateVersion,
          nextState: "failed",
          source: "reconciler",
          reason: "session reported failed",
          attemptId,
          lastSummary: snapshot.latestSummary ?? task.lastSummary,
          completedAt: new Date()
        });
      } else if (snapshot.sessionState === "cancelled" && (task.state === "cancelling" || task.state === "lost") && canTransition(task.state, "cancelled")) {
        await repository.transitionTaskState({
          taskId: task.taskId,
          expectedStateVersion: task.stateVersion,
          nextState: "cancelled",
          source: "reconciler",
          reason: "session reported cancelled",
          attemptId,
          lastSummary: snapshot.latestSummary ?? task.lastSummary,
          completedAt: new Date()
        });
      }
    } else {
      if (worker && !["offline", "lost"].includes(worker.status)) {
        if (task.state === "lost" && canTransition("lost", "blocked")) {
          await repository.transitionTaskState({
            taskId: task.taskId,
            expectedStateVersion: task.stateVersion,
            nextState: "blocked",
            source: "reconciler",
            reason: "worker still visible but session truth missing",
            attemptId
          });
        }
      } else if (shouldMarkTaskLost(worker?.status ?? null, false) && task.state !== "lost" && canTransition(task.state, "lost")) {
        const version = await repository.transitionTaskState({
          taskId: task.taskId,
          expectedStateVersion: task.stateVersion,
          nextState: "lost",
          source: "reconciler",
          reason: "worker truth and session truth both unavailable",
          attemptId
        });
        await repository.enqueueNotification({
          taskId: task.taskId,
          threadKey: task.threadKey,
          notificationKind: "system",
          dedupeKey: buildNotificationDedupeKey(task.taskId, "system", version, "lost"),
          payload: {
            taskId: task.taskId,
            threadKey: task.threadKey,
            notificationKind: "system",
            stateVersion: version.toString(),
            message: `任务 ${task.taskId}\n当前状态：${toPublicStateLabel("lost")}\n摘要：reconciler 无法确认 worker 与 session 的真实状态，需要人工介入。`
          },
          stateVersion: version
        });
      }
    }

    await repository.appendTaskEvent({
      taskId: task.taskId,
      attemptId,
      eventType: "RECONCILIATION_APPLIED",
      source: "reconciler",
      reason: "reconciliation pass completed",
      payloadJson: {
        workerStatus: worker?.status ?? null,
        sessionExists: snapshot?.sessionExists ?? false,
        sessionState: snapshot?.sessionState ?? null
      }
    });
  } finally {
    await repository.releaseLease(taskId, `reconciler:${process.pid}`, token);
  }
}

async function runReconcilerPass() {
  const staleWorkers = await repository.detectLostWorkers(new Date(Date.now() - config.STUCK_THRESHOLD_SECONDS * 1000));
  for (const worker of staleWorkers.affectedWorkers) {
    const attempts = await repository.findAttemptsByWorker(worker.workerId);
    for (const attempt of attempts) {
      await repository.appendTaskEvent({
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        eventType: "WORKER_MARKED_LOST",
        source: "reconciler",
        reason: "worker heartbeat exceeded threshold",
        payloadJson: {
          workerId: worker.workerId
        }
      });
    }
  }

  const candidates = await repository.listReconcileCandidates(new Date(Date.now() - config.STUCK_THRESHOLD_SECONDS * 1000));
  for (const task of candidates) {
    await reconcileTask(task.taskId);
  }
}

setInterval(() => {
  runReconcilerPass().catch((error) => {
    logger.error({ err: error }, "reconciler pass failed");
  });
}, config.RECONCILE_INTERVAL_SECONDS * 1000);

runReconcilerPass().catch((error) => {
  logger.error({ err: error }, "initial reconciler pass failed");
});

logger.info("channelpilot reconciler started");
