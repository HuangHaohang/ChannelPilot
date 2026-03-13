import "dotenv/config";
import Fastify from "fastify";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import pino from "pino";
import { loadRuntimeConfig } from "@channelpilot/shared-types";
import { ChannelPilotRepository } from "@channelpilot/db";
import { FileBackedMockOpenClawStore, MockOpenClawAdapter } from "@channelpilot/openclaw-adapter";
import { TaskService } from "./task-service.js";

const config = loadRuntimeConfig({
  ...process.env,
  API_PORT: process.env.API_PORT ?? "4300"
});
const logger = pino({ level: config.LOG_LEVEL });
const repository = new ChannelPilotRepository();
const adapter = new MockOpenClawAdapter(new FileBackedMockOpenClawStore(config.MOCK_OPENCLAW_STATE_FILE));
const taskService = new TaskService(repository, adapter, config, logger);

const metrics = new Registry();
collectDefaultMetrics({ register: metrics });

const ingestCounter = new Counter({
  name: "channelpilot_ingest_total",
  help: "Total ingested messages",
  registers: [metrics]
});
const createdCounter = new Counter({
  name: "channelpilot_tasks_created_total",
  help: "Total tasks created",
  registers: [metrics]
});
const tasksByStateGauge = new Gauge({
  name: "channelpilot_tasks_by_state",
  help: "Tasks grouped by current state",
  labelNames: ["state"] as const,
  registers: [metrics]
});

async function refreshTaskStateMetrics() {
  const counts = await repository.client.task.groupBy({
    by: ["state"],
    _count: { _all: true }
  });

  tasksByStateGauge.reset();
  for (const row of counts) {
    tasksByStateGauge.set({ state: row.state }, row._count._all);
  }
}

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL
  }
});

app.addHook("onResponse", async () => {
  await refreshTaskStateMetrics();
});

app.post("/ingest/channel-message", async (request, reply) => {
  ingestCounter.inc();
  const result = await taskService.ingestChannelMessage(request.body as never);
  if (result.taskId && result.accepted) {
    createdCounter.inc();
  }
  return reply.send(result);
});

app.post("/tasks", async (request, reply) => {
  const body = request.body as {
    channel: string;
    accountId: string;
    threadKey: string;
    requesterId: string;
    sourceMessageId: string;
    goal: string;
    repo?: string;
    idempotencyKey?: string;
  };
  const result = await taskService.createTaskFromApi(body);
  if (result.taskId && result.accepted) {
    createdCounter.inc();
  }
  return reply.send(result);
});

app.get("/tasks/:taskId", async (request, reply) => {
  const task = await taskService.getTask((request.params as { taskId: string }).taskId);
  if (!task) {
    return reply.code(404).send({ message: "task not found" });
  }
  return reply.send(task);
});

app.post("/tasks/:taskId/steer", async (request, reply) => {
  const params = request.params as { taskId: string };
  const body = request.body as {
    requesterId: string;
    channel: string;
    accountId: string;
    threadKey: string;
    sourceMessageId: string;
    text: string;
    idempotencyKey?: string;
  };
  return reply.send(await taskService.steerTaskDirect({ taskId: params.taskId, ...body }));
});

app.post("/tasks/:taskId/stop", async (request, reply) => {
  const params = request.params as { taskId: string };
  const body = request.body as {
    requesterId: string;
    channel: string;
    accountId: string;
    threadKey: string;
    sourceMessageId: string;
    idempotencyKey?: string;
  };
  return reply.send(await taskService.stopTaskDirect({ taskId: params.taskId, ...body }));
});

app.post("/tasks/:taskId/resume", async (request, reply) => {
  const params = request.params as { taskId: string };
  const body = request.body as {
    requesterId: string;
    channel: string;
    accountId: string;
    threadKey: string;
    sourceMessageId: string;
    idempotencyKey?: string;
  };
  return reply.send(await taskService.resumeTaskDirect({ taskId: params.taskId, ...body }));
});

app.get("/threads/:threadKey", async (request, reply) => {
  const { threadKey } = request.params as { threadKey: string };
  return reply.send(await taskService.getThreadView(threadKey));
});

app.get("/workers", async (_request, reply) => {
  return reply.send(await repository.listWorkers());
});

app.get("/healthz", async (_request, reply) => {
  return reply.send({ ok: true, service: "channelpilot-api" });
});

app.get("/readyz", async (_request, reply) => {
  await repository.client.$queryRaw`SELECT 1`;
  return reply.send({ ok: true, database: "ready" });
});

app.get("/metrics", async (_request, reply) => {
  reply.header("Content-Type", metrics.contentType);
  return reply.send(await metrics.metrics());
});

app.register(async (internalApp) => {
  internalApp.addHook("preHandler", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (authHeader !== `Bearer ${config.INTERNAL_API_TOKEN}`) {
      return reply.code(401).send({ message: "unauthorized" });
    }
  });

  internalApp.post("/attempts/:attemptId/report", async (request, reply) => {
    const { attemptId } = request.params as { attemptId: string };
    const body = request.body as {
      attemptState: "accepted" | "running" | "waiting_input" | "completed" | "failed" | "cancelled" | "lost";
      summary?: string;
      resultJson?: Record<string, unknown>;
      exitCode?: number | null;
    };
    await taskService.reportAttemptProgress({
      attemptId,
      attemptState: body.attemptState,
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.resultJson !== undefined ? { resultJson: body.resultJson } : {}),
      ...(body.exitCode !== undefined ? { exitCode: body.exitCode } : {})
    });
    return reply.send({ ok: true });
  });
}, { prefix: "/internal" });

app.listen({ host: "0.0.0.0", port: config.API_PORT }).then(() => {
  logger.info({ port: config.API_PORT }, "channelpilot api listening");
});
