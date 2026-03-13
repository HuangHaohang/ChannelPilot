import { TaskService } from "./task-service.js";

describe("TaskService", () => {
  const logger = {
    error: vi.fn()
  };
  const config = {
    APP_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgresql://example",
    INTERNAL_API_TOKEN: "token",
    DEFAULT_BACKEND: "codex" as const,
    LEASE_SECONDS: 30,
    RECONCILE_INTERVAL_SECONDS: 15,
    STUCK_THRESHOLD_SECONDS: 180,
    CANCEL_GRACE_SECONDS: 20,
    MAX_PROGRESS_MESSAGE_FREQUENCY_SECONDS: 300,
    WORKSPACE_ROOT: "/tmp/workspaces",
    ARTIFACT_ROOT: "/tmp/artifacts",
    AUTHORIZED_OPERATOR_IDS: "telegram:uid:123",
    PERMITTED_REPOS: "payments",
    MOCK_OPENCLAW_STATE_FILE: ".data/mock-openclaw-state.json",
    WORKER_REGISTRY_URL: "http://localhost:4301",
    API_BASE_URL: "http://localhost:4300",
    API_PORT: 4300,
    WORKER_REGISTRY_PORT: 4301,
    authorizedOperatorIds: ["telegram:uid:123"],
    permittedRepos: ["payments"]
  };

  function createService(dependencies?: {
    repository?: Record<string, unknown>;
    adapter?: Record<string, unknown>;
  }) {
    const repository = {
      findIdempotencyRecord: vi.fn().mockResolvedValue(null),
      getCurrentActiveMainTask: vi.fn().mockResolvedValue(null),
      getTaskById: vi.fn(),
      getAttemptById: vi.fn(),
      transitionTaskState: vi.fn(),
      appendTaskEvent: vi.fn().mockResolvedValue(undefined),
      enqueueNotification: vi.fn().mockResolvedValue(undefined),
      updateTaskSnapshot: vi.fn().mockResolvedValue(undefined),
      recordNonTaskInboundMessage: vi.fn().mockResolvedValue(undefined),
      persistIdempotentResponse: vi.fn().mockResolvedValue(undefined),
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      ...(dependencies?.repository ?? {})
    };
    const adapter = {
      steerSession: vi.fn().mockResolvedValue(undefined),
      cancelSession: vi.fn().mockResolvedValue(undefined),
      getSessionStatus: vi.fn().mockResolvedValue({
        sessionExists: true,
        sessionState: "running",
        lastActivityAt: new Date().toISOString(),
        latestSummary: null
      }),
      ...(dependencies?.adapter ?? {})
    };

    return {
      repository,
      adapter,
      service: new TaskService(repository as never, adapter as never, config, logger as never)
    };
  }

  it("returns the existing result on idempotent replay", async () => {
    const { service } = createService({
      repository: {
        findIdempotencyRecord: vi.fn().mockResolvedValue({
          responseJson: {
            accepted: true,
            taskId: "T-20260314-00001",
            state: "running",
            messageForOperator: "existing"
          }
        })
      }
    });

    const result = await service.ingestChannelMessage({
      channel: "telegram",
      accountId: "acc-1",
      threadKey: "telegram:-100:topic:42",
      requesterId: "telegram:uid:123",
      sourceMessageId: "msg-1",
      text: "状态"
    });

    expect(result.messageForOperator).toBe("existing");
  });

  it("rejects creating a second active main task in the same thread", async () => {
    const { service } = createService({
      repository: {
        getCurrentActiveMainTask: vi.fn().mockResolvedValue({
          taskId: "T-20260314-00001",
          state: "running"
        })
      }
    });

    const result = await service.ingestChannelMessage({
      channel: "telegram",
      accountId: "acc-1",
      threadKey: "telegram:-100:topic:42",
      requesterId: "telegram:uid:123",
      sourceMessageId: "msg-2",
      text: "让 codex 在 repo payments 修复 CI 失败"
    });

    expect(result.accepted).toBe(false);
    expect(result.messageForOperator).toContain("当前 thread 已有进行中的主任务");
  });

  it("syncs attempt state, summary, and progress notification when resuming a waiting task", async () => {
    const task = {
      taskId: "T-20260314-00003",
      state: "waiting_input",
      stateVersion: 7n,
      currentAttemptId: "A-20260314-00003",
      lastSummary: "任务需要人工输入。",
      threadKey: "telegram:-100:topic:65",
      attempts: []
    };
    const attempt = {
      attemptId: "A-20260314-00003",
      taskId: task.taskId,
      attemptState: "waiting_input",
      acpSessionId: "session-1",
      acpSessionKey: "session-key-1"
    };
    const { repository, adapter, service } = createService({
      repository: {
        getTaskById: vi.fn().mockResolvedValue(task),
        getAttemptById: vi.fn().mockResolvedValue(attempt),
        transitionTaskState: vi.fn().mockResolvedValue(8n)
      }
    });

    const result = await service.resumeTaskDirect({
      taskId: task.taskId,
      requesterId: "telegram:uid:123",
      channel: "telegram",
      accountId: "acc-1",
      threadKey: task.threadKey,
      sourceMessageId: "msg-3"
    });

    expect(result).toEqual({
      accepted: true,
      taskId: task.taskId,
      state: "running",
      messageForOperator: `任务 ${task.taskId}\n当前状态：执行中\n摘要：已恢复执行。`
    });
    expect(adapter.steerSession).toHaveBeenCalledWith({
      sessionHandle: {
        sessionId: attempt.acpSessionId,
        sessionKey: attempt.acpSessionKey
      },
      text: "继续执行"
    });
    expect(repository.transitionTaskState).toHaveBeenCalledWith({
      taskId: task.taskId,
      expectedStateVersion: task.stateVersion,
      nextState: "running",
      source: "task_service",
      reason: "operator requested resume",
      attemptId: task.currentAttemptId,
      attemptState: "running",
      attemptEndedAt: null,
      lastSummary: "已恢复执行。"
    });
    expect(repository.appendTaskEvent).toHaveBeenCalledWith({
      taskId: task.taskId,
      attemptId: task.currentAttemptId,
      eventType: "RESUME_REQUESTED",
      source: "task_service",
      reason: "operator requested resume",
      payloadJson: {
        requesterId: "telegram:uid:123"
      }
    });
    expect(repository.enqueueNotification).toHaveBeenCalledWith({
      taskId: task.taskId,
      threadKey: task.threadKey,
      notificationKind: "progress",
      dedupeKey: expect.stringContaining(`${task.taskId}:progress:8:resume`),
      payload: {
        taskId: task.taskId,
        threadKey: task.threadKey,
        notificationKind: "progress",
        stateVersion: "8",
        message: result.messageForOperator
      },
      stateVersion: 8n
    });
    expect(repository.persistIdempotentResponse).toHaveBeenCalledWith({
      idempotencyKey: `${task.threadKey}:msg-3`,
      requesterId: "telegram:uid:123",
      threadKey: task.threadKey,
      taskId: task.taskId,
      response: {
        accepted: true,
        taskId: task.taskId,
        state: "running",
        messageForOperator: result.messageForOperator
      }
    });
  });
});
