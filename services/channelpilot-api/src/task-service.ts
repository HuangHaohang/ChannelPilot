import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import type { AttemptState, IngestChannelMessageInput, NormalizedCommand, NotificationKind, OperatorMessageResponse, TaskOperation } from "@channelpilot/shared-types";
import { buildNotificationDedupeKey, canTransition, createStateTransition, normalizeCommand, resolveTaskTarget, toPublicStateLabel, toPublicTaskState } from "@channelpilot/domain";
import { ChannelPilotRepository, createAttemptId, createLeaseToken, createTaskId } from "@channelpilot/db";
import type { OpenClawAdapter, SessionHandle } from "@channelpilot/openclaw-adapter";
import type { RuntimeConfig } from "@channelpilot/shared-types";
import pino from "pino";

function isExplicitlyDangerous(text: string): boolean {
  const lowered = text.toLowerCase();
  return ["rm -rf", "format c:", "del /s", "shutdown -s", "drop database"].some((pattern) => lowered.includes(pattern));
}

function buildOperatorMessage(taskId: string, stateLabel: string, summary?: string | null): string {
  return summary ? `任务 ${taskId}\n当前状态：${stateLabel}\n摘要：${summary}` : `任务 ${taskId}\n当前状态：${stateLabel}`;
}

function serializeResponse(responseJson: unknown): OperatorMessageResponse | null {
  if (!responseJson || typeof responseJson !== "object") {
    return null;
  }

  return responseJson as OperatorMessageResponse;
}

export interface ReportAttemptInput {
  attemptId: string;
  attemptState: AttemptState;
  summary?: string | undefined;
  resultJson?: Record<string, unknown> | undefined;
  exitCode?: number | null | undefined;
}

export class TaskService {
  constructor(
    private readonly repository: ChannelPilotRepository,
    private readonly adapter: OpenClawAdapter,
    private readonly config: RuntimeConfig,
    private readonly logger: pino.Logger
  ) {}

  private ensureAuthorized(requesterId: string): void {
    if (this.config.authorizedOperatorIds.length === 0) {
      return;
    }

    if (!this.config.authorizedOperatorIds.includes(requesterId)) {
      throw new Error(`requester 未授权: ${requesterId}`);
    }
  }

  private ensureRepoAllowed(repo?: string): void {
    if (this.config.permittedRepos.length === 0) {
      return;
    }

    if (!repo) {
      throw new Error("当前策略要求明确指定 repo。");
    }

    if (!this.config.permittedRepos.includes(repo)) {
      throw new Error(`repo 不在 allowlist 中: ${repo}`);
    }
  }

  private async persistStandaloneResponse(
    raw: IngestChannelMessageInput,
    command: NormalizedCommand,
    response: OperatorMessageResponse,
    taskId?: string
  ): Promise<OperatorMessageResponse> {
    await this.repository.recordNonTaskInboundMessage({
      channel: raw.channel,
      accountId: raw.accountId,
      threadKey: raw.threadKey,
      requesterId: raw.requesterId,
      sourceMessageId: raw.sourceMessageId,
      rawPayloadJson: raw as never,
      normalizedCommandJson: command as never,
      idempotencyKey: command.idempotencyKey,
      processingResult: response.accepted ? "accepted" : "rejected"
    });
    await this.repository.persistIdempotentResponse({
      idempotencyKey: command.idempotencyKey,
      requesterId: raw.requesterId,
      threadKey: raw.threadKey,
      ...(taskId !== undefined ? { taskId } : {}),
      response
    });
    await this.repository.appendAuditLog({
      actorId: raw.requesterId,
      action: `command.${command.op}`,
      targetType: taskId ? "task" : "thread",
      targetId: taskId ?? raw.threadKey,
      payloadJson: { sourceMessageId: raw.sourceMessageId }
    });

    return response;
  }

  private createNotificationPayload(taskId: string, threadKey: string, notificationKind: NotificationKind, stateVersion: bigint, message: string) {
    return {
      taskId,
      threadKey,
      notificationKind,
      stateVersion: stateVersion.toString(),
      message
    };
  }

  async ingestChannelMessage(raw: IngestChannelMessageInput): Promise<OperatorMessageResponse> {
    this.ensureAuthorized(raw.requesterId);

    const command = normalizeCommand(raw);
    const existing = await this.repository.findIdempotencyRecord(command.idempotencyKey, raw.requesterId, raw.threadKey);
    const existingResponse = serializeResponse(existing?.responseJson);
    if (existingResponse) {
      return existingResponse;
    }

    if (isExplicitlyDangerous(command.rawText)) {
      return this.persistStandaloneResponse(raw, command, {
        accepted: false,
        messageForOperator: "请求被策略拒绝：检测到明显危险的操作。"
      });
    }

    if (command.op === "help") {
      return this.persistStandaloneResponse(raw, command, {
        accepted: true,
        messageForOperator:
          "支持命令：run / status / steer / stop / resume / summarize / help。未显式提供 taskId 时，status / steer / stop / resume / summarize 会默认作用于当前 thread 的 active main task。"
      });
    }

    const activeTask = await this.repository.getCurrentActiveMainTask(raw.threadKey);
    const resolution = resolveTaskTarget(command, activeTask?.taskId ?? null);

    if (resolution.errorMessage) {
      return this.persistStandaloneResponse(raw, command, {
        accepted: false,
        messageForOperator: resolution.errorMessage,
        ...(activeTask?.taskId ? { taskId: activeTask.taskId } : {}),
        ...(activeTask ? { state: toPublicTaskState(activeTask.state) } : {})
      });
    }

    if (command.op === "run") {
      return this.createTaskFromCommand(raw, command);
    }

    if (!resolution.taskId) {
      return this.persistStandaloneResponse(raw, command, {
        accepted: false,
        messageForOperator: "未能解析目标 task。"
      });
    }

    return this.handleTaskCommand(resolution.taskId, raw, command);
  }

  async createTaskFromApi(input: {
    channel: string;
    accountId: string;
    threadKey: string;
    requesterId: string;
    sourceMessageId: string;
    goal: string;
    repo?: string;
    idempotencyKey?: string;
  }): Promise<OperatorMessageResponse> {
    return this.ingestChannelMessage({
      ...input,
      text: `让 codex 在 repo ${input.repo ?? "unknown"} ${input.goal}`.trim()
    });
  }

  async steerTaskDirect(input: {
    taskId: string;
    requesterId: string;
    channel: string;
    accountId: string;
    threadKey: string;
    sourceMessageId: string;
    text: string;
    idempotencyKey?: string;
  }) {
    return this.handleTaskCommand(input.taskId, input, {
      op: "steer",
      backend: "codex",
      goal: undefined,
      repo: undefined,
      taskId: input.taskId,
      threadKey: input.threadKey,
      requesterId: input.requesterId,
      idempotencyKey: input.idempotencyKey ?? `${input.threadKey}:${input.sourceMessageId}`,
      sourceMessageId: input.sourceMessageId,
      constraints: [],
      rawText: input.text
    });
  }

  async stopTaskDirect(input: {
    taskId: string;
    requesterId: string;
    channel: string;
    accountId: string;
    threadKey: string;
    sourceMessageId: string;
    idempotencyKey?: string;
  }) {
    return this.handleTaskCommand(input.taskId, { ...input, text: "停止" }, {
      op: "stop",
      backend: "codex",
      taskId: input.taskId,
      threadKey: input.threadKey,
      requesterId: input.requesterId,
      idempotencyKey: input.idempotencyKey ?? `${input.threadKey}:${input.sourceMessageId}`,
      sourceMessageId: input.sourceMessageId,
      constraints: [],
      rawText: "停止"
    });
  }

  async resumeTaskDirect(input: {
    taskId: string;
    requesterId: string;
    channel: string;
    accountId: string;
    threadKey: string;
    sourceMessageId: string;
    idempotencyKey?: string;
  }) {
    return this.handleTaskCommand(input.taskId, { ...input, text: "继续" }, {
      op: "resume",
      backend: "codex",
      taskId: input.taskId,
      threadKey: input.threadKey,
      requesterId: input.requesterId,
      idempotencyKey: input.idempotencyKey ?? `${input.threadKey}:${input.sourceMessageId}`,
      sourceMessageId: input.sourceMessageId,
      constraints: [],
      rawText: "继续"
    });
  }

  async getTask(taskId: string) {
    const task = await this.repository.getTaskById(taskId);
    if (!task) {
      return null;
    }

    const attempt = task.currentAttemptId ? await this.repository.getAttemptById(task.currentAttemptId) : task.attempts[0] ?? null;

    return {
      taskId: task.taskId,
      title: task.title,
      requestedGoal: task.requestedGoal,
      backend: task.backend,
      state: task.state,
      publicState: toPublicTaskState(task.state),
      stateVersion: task.stateVersion.toString(),
      desiredState: task.desiredState,
      requesterId: task.requesterId,
      channel: task.channel,
      accountId: task.accountId,
      threadKey: task.threadKey,
      repo: task.repo,
      cwd: task.cwd,
      currentAttemptId: task.currentAttemptId,
      lastSummary: task.lastSummary,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      attempt: attempt
        ? {
            attemptId: attempt.attemptId,
            attemptState: attempt.attemptState,
            assignedWorkerId: attempt.assignedWorkerId,
            acpSessionId: attempt.acpSessionId,
            bindingKey: attempt.bindingKey,
            startedAt: attempt.startedAt.toISOString(),
            endedAt: attempt.endedAt?.toISOString() ?? null
          }
        : null
    };
  }

  async getThreadView(threadKey: string) {
    return this.repository.getThreadView(threadKey);
  }

  private async createTaskFromCommand(raw: IngestChannelMessageInput, command: NormalizedCommand): Promise<OperatorMessageResponse> {
    this.ensureRepoAllowed(command.repo);

    const taskId = createTaskId();
    const attemptId = createAttemptId();
    const title = command.goal?.slice(0, 80) || "OpenClaw task";

    const baseResponse: OperatorMessageResponse = {
      accepted: true,
      taskId,
      state: "queued",
      messageForOperator: `已创建任务 ${taskId}\nbackend: codex\n当前状态：已受理`
    };

    try {
      await this.repository.createTaskBundle({
        taskId,
        attemptId,
        channel: raw.channel,
        accountId: raw.accountId,
        title,
        requestedGoal: command.goal ?? command.rawText,
        requesterId: raw.requesterId,
        threadKey: raw.threadKey,
        command,
        rawMessage: raw,
        idempotentResponse: baseResponse,
        ...(command.repo !== undefined ? { repo: command.repo } : {})
      });
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
        return this.persistStandaloneResponse(raw, command, {
          accepted: false,
          messageForOperator:
            "当前 thread 已有进行中的主任务。请使用 steer / stop / summarize，或等待当前任务结束后再创建新任务。"
        });
      }

      throw error;
    }

    let stateVersion = 0n;
    const currentTask = await this.repository.getTaskById(taskId);
    if (!currentTask) {
      throw new Error(`task 创建后不可见: ${taskId}`);
    }

    stateVersion = await this.repository.transitionTaskState({
      taskId,
      expectedStateVersion: currentTask.stateVersion,
      nextState: "starting",
      source: "task_service",
      reason: "preparing session",
      attemptId
    });

    let sessionHandle: SessionHandle | undefined;

    try {
      const workers = await this.repository.listWorkers();
      const freshnessCutoff = Date.now() - this.config.STUCK_THRESHOLD_SECONDS * 1000;
      const selectedWorker = workers.find((worker) => {
        if (worker.status !== "idle") {
          return false;
        }

        return new Date(worker.lastSeenAt).getTime() >= freshnessCutoff;
      }) ?? null;
      if (selectedWorker) {
        await this.repository.assignAttemptToWorker({
          attemptId,
          workerId: selectedWorker.workerId,
          metadata: {
            selectedAt: new Date().toISOString(),
            selectionReason: "first-idle-worker"
          }
        });
      }

      sessionHandle = await this.adapter.spawnOrReuseSession({
        threadKey: raw.threadKey,
        backend: "codex",
        repo: command.repo,
        prompt: command.goal ?? command.rawText,
        taskId,
        attemptId
      });
      await this.repository.appendTaskEvent({
        taskId,
        attemptId,
        eventType: "SESSION_SPAWNED",
        source: "openclaw_adapter",
        reason: "session spawned",
        payloadJson: sessionHandle as never
      });
      await this.repository.updateAttempt({
        attemptId,
        acpSessionId: sessionHandle.sessionId,
        acpSessionKey: sessionHandle.sessionKey,
        attemptState: "accepted"
      });

      stateVersion = await this.repository.transitionTaskState({
        taskId,
        expectedStateVersion: stateVersion,
        nextState: "binding",
        source: "task_service",
        reason: "binding thread",
        attemptId
      });

      const binding = await this.adapter.ensureThreadBinding({
        threadKey: raw.threadKey,
        sessionHandle
      });
      await this.repository.appendTaskEvent({
        taskId,
        attemptId,
        eventType: "THREAD_BOUND",
        source: "openclaw_adapter",
        reason: "thread bound",
        payloadJson: binding as never
      });
      await this.repository.updateAttempt({
        attemptId,
        bindingKey: binding.bindingKey
      });

      stateVersion = await this.repository.transitionTaskState({
        taskId,
        expectedStateVersion: stateVersion,
        nextState: "running",
        source: "task_service",
        reason: "task started",
        attemptId,
        lastSummary: "任务已启动，等待 worker 回报。"
      });

      const finalResponse: OperatorMessageResponse = {
        accepted: true,
        taskId,
        state: "running",
        messageForOperator: buildOperatorMessage(taskId, toPublicStateLabel("running"), "任务已启动，等待 worker 回报。")
      };

      await this.repository.enqueueNotification({
        taskId,
        threadKey: raw.threadKey,
        notificationKind: "receipt",
        dedupeKey: buildNotificationDedupeKey(taskId, "receipt", stateVersion),
        payload: this.createNotificationPayload(taskId, raw.threadKey, "receipt", stateVersion, finalResponse.messageForOperator),
        stateVersion
      });
      await this.repository.persistIdempotentResponse({
        idempotencyKey: command.idempotencyKey,
        requesterId: raw.requesterId,
        threadKey: raw.threadKey,
        taskId,
        response: finalResponse
      });

      return finalResponse;
    } catch (error) {
      const failedState = sessionHandle ? "binding" : "starting";
      const failedVersion = stateVersion;
      if (canTransition(failedState, "failed")) {
        await this.repository.transitionTaskState({
          taskId,
          expectedStateVersion: failedVersion,
          nextState: "failed",
          source: "task_service",
          reason: error instanceof Error ? error.message : "session bootstrap failed",
          attemptId
        });
        await this.repository.updateAttempt({
          attemptId,
          attemptState: "failed",
          exitCode: 1,
          resultJson: {
            error: error instanceof Error ? error.message : "unknown"
          },
          endedAt: new Date()
        });
      }

      this.logger.error({ err: error, taskId }, "task bootstrap failed");
      const failureResponse: OperatorMessageResponse = {
        accepted: false,
        taskId,
        state: "failed",
        messageForOperator: `任务 ${taskId} 启动失败：${error instanceof Error ? error.message : "未知错误"}`
      };
      await this.repository.persistIdempotentResponse({
        idempotencyKey: command.idempotencyKey,
        requesterId: raw.requesterId,
        threadKey: raw.threadKey,
        taskId,
        response: failureResponse
      });
      return failureResponse;
    }
  }

  private async handleTaskCommand(taskId: string, raw: IngestChannelMessageInput, command: NormalizedCommand): Promise<OperatorMessageResponse> {
    const task = await this.repository.getTaskById(taskId);
    if (!task) {
      return this.persistStandaloneResponse(raw, command, {
        accepted: false,
        messageForOperator: `任务不存在：${taskId}`
      });
    }

    switch (command.op) {
      case "status":
      case "summarize":
        return this.handleStatusLike(taskId, raw, command);
      case "steer":
        return this.handleSteer(taskId, raw, command);
      case "stop":
        return this.handleStop(taskId, raw, command);
      case "resume":
        return this.handleResume(taskId, raw, command);
      default:
        return this.persistStandaloneResponse(raw, command, {
          accepted: false,
          taskId,
          state: toPublicTaskState(task.state),
          messageForOperator: `当前命令不支持直接作用于任务：${command.op}`
        }, taskId);
    }
  }

  private async getTaskSessionHandle(taskId: string): Promise<{ task: NonNullable<Awaited<ReturnType<ChannelPilotRepository["getTaskById"]>>>; sessionHandle: SessionHandle | null }> {
    const task = await this.repository.getTaskById(taskId);
    if (!task) {
      throw new Error(`任务不存在：${taskId}`);
    }

    const attempt = task.currentAttemptId ? await this.repository.getAttemptById(task.currentAttemptId) : task.attempts[0] ?? null;
    if (!attempt?.acpSessionId || !attempt.acpSessionKey) {
      return { task, sessionHandle: null };
    }

    return {
      task,
      sessionHandle: {
        sessionId: attempt.acpSessionId,
        sessionKey: attempt.acpSessionKey
      }
    };
  }

  private async handleStatusLike(taskId: string, raw: IngestChannelMessageInput, command: NormalizedCommand): Promise<OperatorMessageResponse> {
    const { task, sessionHandle } = await this.getTaskSessionHandle(taskId);
    let latestSummary = task.lastSummary;

    if (sessionHandle) {
      const snapshot = await this.adapter.getSessionStatus({ sessionHandle });
      if (snapshot.latestSummary && snapshot.latestSummary !== task.lastSummary) {
        latestSummary = snapshot.latestSummary;
        await this.repository.updateTaskSnapshot({
          taskId,
          lastSummary: snapshot.latestSummary
        });
      }
    }

    const response: OperatorMessageResponse = {
      accepted: true,
      taskId,
      state: toPublicTaskState(task.state),
      messageForOperator: buildOperatorMessage(taskId, toPublicStateLabel(task.state), latestSummary)
    };

    return this.persistStandaloneResponse(raw, command, response, taskId);
  }

  private async handleSteer(taskId: string, raw: IngestChannelMessageInput, command: NormalizedCommand): Promise<OperatorMessageResponse> {
    const { task, sessionHandle } = await this.getTaskSessionHandle(taskId);
    if (!sessionHandle) {
      return this.persistStandaloneResponse(raw, command, {
        accepted: false,
        taskId,
        state: toPublicTaskState(task.state),
        messageForOperator: "当前任务没有可用的 session，无法追加指令。"
      }, taskId);
    }

    await this.adapter.steerSession({
      sessionHandle,
      text: command.rawText
    });
    await this.repository.appendTaskEvent({
      taskId,
      attemptId: task.currentAttemptId,
      eventType: "STEER_ACCEPTED",
      source: "task_service",
      reason: "operator steer",
      payloadJson: {
        text: command.rawText
      }
    });

    let state = task.state;
    if (task.state === "waiting_input") {
      const resumedSummary = "已记录新的约束并继续执行。";
      const nextVersion = await this.repository.transitionTaskState({
        taskId,
        expectedStateVersion: task.stateVersion,
        nextState: "running",
        source: "task_service",
        reason: "operator provided required input",
        attemptId: task.currentAttemptId,
        attemptState: "running",
        attemptEndedAt: null,
        lastSummary: resumedSummary
      });
      state = "running";
      await this.repository.enqueueNotification({
        taskId,
        threadKey: raw.threadKey,
        notificationKind: "progress",
        dedupeKey: buildNotificationDedupeKey(taskId, "progress", nextVersion, command.rawText),
        payload: this.createNotificationPayload(taskId, raw.threadKey, "progress", nextVersion, `任务 ${taskId}\n当前状态：${toPublicStateLabel("running")}\n摘要：${resumedSummary}`),
        stateVersion: nextVersion
      });
    }

    return this.persistStandaloneResponse(raw, command, {
      accepted: true,
      taskId,
      state: toPublicTaskState(state),
      messageForOperator: `已记录新的约束并发送给当前任务。当前状态：${toPublicStateLabel(state)}`
    }, taskId);
  }

  private async handleStop(taskId: string, raw: IngestChannelMessageInput, command: NormalizedCommand): Promise<OperatorMessageResponse> {
    const { task, sessionHandle } = await this.getTaskSessionHandle(taskId);
    if (!canTransition(task.state, "cancelling") && task.state !== "cancelling") {
      return this.persistStandaloneResponse(raw, command, {
        accepted: false,
        taskId,
        state: toPublicTaskState(task.state),
        messageForOperator: `当前状态 ${toPublicStateLabel(task.state)} 不支持停止。`
      }, taskId);
    }

    let stateVersion = task.stateVersion;
    if (task.state !== "cancelling") {
      await this.repository.appendTaskEvent({
        taskId,
        attemptId: task.currentAttemptId,
        eventType: "STOP_REQUESTED",
        source: "task_service",
        reason: "operator requested stop",
        payloadJson: {
          requesterId: raw.requesterId
        }
      });
      stateVersion = await this.repository.transitionTaskState({
        taskId,
        expectedStateVersion: task.stateVersion,
        nextState: "cancelling",
        source: "task_service",
        reason: "operator requested stop",
        attemptId: task.currentAttemptId,
        desiredState: "cancelled"
      });
    }

    if (sessionHandle) {
      await this.adapter.cancelSession({
        sessionHandle,
        reason: "operator requested stop"
      });
    }

    const message = `任务 ${taskId}\n当前状态：正在取消`;
    await this.repository.enqueueNotification({
      taskId,
      threadKey: raw.threadKey,
      notificationKind: "receipt",
      dedupeKey: buildNotificationDedupeKey(taskId, "receipt", stateVersion, "cancelling"),
      payload: this.createNotificationPayload(taskId, raw.threadKey, "receipt", stateVersion, message),
      stateVersion
    });

    return this.persistStandaloneResponse(raw, command, {
      accepted: true,
      taskId,
      state: toPublicTaskState("cancelling"),
      messageForOperator: message
    }, taskId);
  }

  private async handleResume(taskId: string, raw: IngestChannelMessageInput, command: NormalizedCommand): Promise<OperatorMessageResponse> {
    const { task, sessionHandle } = await this.getTaskSessionHandle(taskId);
    if (!canTransition(task.state, "running")) {
      return this.persistStandaloneResponse(raw, command, {
        accepted: false,
        taskId,
        state: toPublicTaskState(task.state),
        messageForOperator: `当前状态 ${toPublicStateLabel(task.state)} 不支持恢复。`
      }, taskId);
    }

    if (sessionHandle) {
      await this.adapter.steerSession({
        sessionHandle,
        text: "继续执行"
      });
    }

    const resumedSummary = "已恢复执行。";
    const nextVersion = await this.repository.transitionTaskState({
      taskId,
      expectedStateVersion: task.stateVersion,
      nextState: "running",
      source: "task_service",
      reason: "operator requested resume",
      attemptId: task.currentAttemptId,
      attemptState: "running",
      attemptEndedAt: null,
      lastSummary: resumedSummary
    });

    await this.repository.appendTaskEvent({
      taskId,
      attemptId: task.currentAttemptId,
      eventType: "RESUME_REQUESTED",
      source: "task_service",
      reason: "operator requested resume",
      payloadJson: {
        requesterId: raw.requesterId
      }
    });

    const response: OperatorMessageResponse = {
      accepted: true,
      taskId,
      state: "running",
      messageForOperator: `任务 ${taskId}\n当前状态：${toPublicStateLabel("running")}\n摘要：${resumedSummary}`
    };

    await this.repository.enqueueNotification({
      taskId,
      threadKey: raw.threadKey,
      notificationKind: "progress",
      dedupeKey: buildNotificationDedupeKey(taskId, "progress", nextVersion, "resume"),
      payload: this.createNotificationPayload(taskId, raw.threadKey, "progress", nextVersion, response.messageForOperator),
      stateVersion: nextVersion
    });

    return this.persistStandaloneResponse(raw, command, response, taskId);
  }

  async reportAttemptProgress(input: ReportAttemptInput): Promise<void> {
    const attempt = await this.repository.getAttemptById(input.attemptId);
    if (!attempt) {
      throw new Error(`attempt 不存在: ${input.attemptId}`);
    }

    const task = await this.repository.getTaskById(attempt.taskId);
    if (!task) {
      throw new Error(`task 不存在: ${attempt.taskId}`);
    }

    let stateVersion = task.stateVersion;

    await this.repository.updateAttempt({
      attemptId: input.attemptId,
      attemptState: input.attemptState,
      ...(input.resultJson !== undefined ? { resultJson: input.resultJson as never } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      endedAt: ["completed", "failed", "cancelled", "lost"].includes(input.attemptState) ? new Date() : null
    });

    switch (input.attemptState) {
      case "running":
        if (task.state !== "running" && canTransition(task.state, "running")) {
          stateVersion = await this.repository.transitionTaskState({
            taskId: task.taskId,
            expectedStateVersion: stateVersion,
            nextState: "running",
            source: "task_service",
            reason: "worker reported running",
            attemptId: input.attemptId,
            lastSummary: input.summary ?? task.lastSummary
          });
        } else if (input.summary) {
          await this.repository.updateTaskSnapshot({
            taskId: task.taskId,
            lastSummary: input.summary
          });
        }
        break;
      case "waiting_input":
        if (canTransition(task.state, "waiting_input")) {
          stateVersion = await this.repository.transitionTaskState({
            taskId: task.taskId,
            expectedStateVersion: stateVersion,
            nextState: "waiting_input",
            source: "task_service",
            reason: "worker requested input",
            attemptId: input.attemptId,
            lastSummary: input.summary ?? "任务需要人工输入。"
          });
          await this.repository.enqueueNotification({
            taskId: task.taskId,
            threadKey: task.threadKey,
            notificationKind: "waiting_input",
            dedupeKey: buildNotificationDedupeKey(task.taskId, "waiting_input", stateVersion, input.summary),
            payload: this.createNotificationPayload(
              task.taskId,
              task.threadKey,
              "waiting_input",
              stateVersion,
              buildOperatorMessage(task.taskId, toPublicStateLabel("waiting_input"), input.summary ?? "任务需要人工输入。")
            ),
            stateVersion
          });
        }
        break;
      case "completed":
        if (canTransition(task.state, "summarizing")) {
          stateVersion = await this.repository.transitionTaskState({
            taskId: task.taskId,
            expectedStateVersion: stateVersion,
            nextState: "summarizing",
            source: "task_service",
            reason: "worker completed, summarizing",
            attemptId: input.attemptId,
            lastSummary: input.summary ?? task.lastSummary
          });
          stateVersion = await this.repository.transitionTaskState({
            taskId: task.taskId,
            expectedStateVersion: stateVersion,
            nextState: "completed",
            source: "task_service",
            reason: "summary assembled",
            attemptId: input.attemptId,
            lastSummary: input.summary ?? task.lastSummary,
            completedAt: new Date()
          });
          await this.repository.enqueueNotification({
            taskId: task.taskId,
            threadKey: task.threadKey,
            notificationKind: "final",
            dedupeKey: buildNotificationDedupeKey(task.taskId, "final", stateVersion, input.summary),
            payload: this.createNotificationPayload(
              task.taskId,
              task.threadKey,
              "final",
              stateVersion,
              buildOperatorMessage(task.taskId, toPublicStateLabel("completed"), input.summary ?? task.lastSummary)
            ),
            stateVersion
          });
        }
        break;
      case "failed":
        if (canTransition(task.state, "failed")) {
          stateVersion = await this.repository.transitionTaskState({
            taskId: task.taskId,
            expectedStateVersion: stateVersion,
            nextState: "failed",
            source: "task_service",
            reason: "worker reported failed",
            attemptId: input.attemptId,
            lastSummary: input.summary ?? task.lastSummary,
            completedAt: new Date()
          });
          await this.repository.enqueueNotification({
            taskId: task.taskId,
            threadKey: task.threadKey,
            notificationKind: "final",
            dedupeKey: buildNotificationDedupeKey(task.taskId, "final", stateVersion, input.summary),
            payload: this.createNotificationPayload(
              task.taskId,
              task.threadKey,
              "final",
              stateVersion,
              buildOperatorMessage(task.taskId, toPublicStateLabel("failed"), input.summary ?? "任务执行失败。")
            ),
            stateVersion
          });
        }
        break;
      case "cancelled":
        if (task.state === "cancelling" || task.state === "lost") {
          stateVersion = await this.repository.transitionTaskState({
            taskId: task.taskId,
            expectedStateVersion: stateVersion,
            nextState: "cancelled",
            source: "task_service",
            reason: "worker reported cancelled",
            attemptId: input.attemptId,
            lastSummary: input.summary ?? task.lastSummary,
            completedAt: new Date()
          });
          await this.repository.enqueueNotification({
            taskId: task.taskId,
            threadKey: task.threadKey,
            notificationKind: "final",
            dedupeKey: buildNotificationDedupeKey(task.taskId, "final", stateVersion, input.summary),
            payload: this.createNotificationPayload(
              task.taskId,
              task.threadKey,
              "final",
              stateVersion,
              buildOperatorMessage(task.taskId, toPublicStateLabel("cancelled"), input.summary ?? "任务已取消。")
            ),
            stateVersion
          });
        }
        break;
      default:
        break;
    }
  }
}
