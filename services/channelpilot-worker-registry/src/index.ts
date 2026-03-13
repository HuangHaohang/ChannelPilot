import "dotenv/config";
import Fastify from "fastify";
import pino from "pino";
import { ChannelPilotRepository } from "@channelpilot/db";
import { loadRuntimeConfig } from "@channelpilot/shared-types";

const config = loadRuntimeConfig(process.env);
const logger = pino({ level: config.LOG_LEVEL });
const repository = new ChannelPilotRepository();

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL
  }
});

app.register(async (internalApp) => {
  internalApp.addHook("preHandler", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (authHeader !== `Bearer ${config.INTERNAL_API_TOKEN}`) {
      return reply.code(401).send({ message: "unauthorized" });
    }
  });

  internalApp.post("/workers/register", async (request, reply) => {
    const body = request.body as {
      workerId: string;
      label: string;
      host: string;
      capabilities: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      status?: "idle" | "busy" | "offline" | "lost";
    };

    const worker = await repository.upsertWorker({
      workerId: body.workerId,
      label: body.label,
      host: body.host,
      capabilitiesJson: body.capabilities as never,
      metadataJson: (body.metadata ?? {}) as never,
      ...(body.status !== undefined ? { status: body.status } : {})
    });

    return reply.send(worker);
  });

  internalApp.post("/workers/:workerId/heartbeat", async (request, reply) => {
    const { workerId } = request.params as { workerId: string };
    const body = request.body as {
      status?: "idle" | "busy" | "offline" | "lost";
      metadata?: Record<string, unknown>;
    };

    const worker = await repository.heartbeatWorker(workerId, body.status, body.metadata as never);
    return reply.send(worker);
  });

  internalApp.post("/workers/:workerId/availability", async (request, reply) => {
    const { workerId } = request.params as { workerId: string };
    const body = request.body as {
      status: "idle" | "busy" | "offline" | "lost";
      metadata?: Record<string, unknown>;
    };

    const worker = await repository.heartbeatWorker(workerId, body.status, body.metadata as never);
    return reply.send(worker);
  });

  internalApp.post("/assignments/:attemptId/claim", async (request, reply) => {
    const { attemptId } = request.params as { attemptId: string };
    const body = request.body as {
      workerId: string;
      metadata?: Record<string, unknown>;
    };

    const attempt = await repository.assignAttemptToWorker({
      attemptId,
      workerId: body.workerId,
      metadata: {
        ...(body.metadata ?? {}),
        claimedAt: new Date().toISOString()
      }
    });

    return reply.send({
      ok: true,
      attemptId: attempt.attemptId,
      workerId: body.workerId
    });
  });

  internalApp.post("/workers/:workerId/assignments/:attemptId/report", async (request, reply) => {
    const { workerId, attemptId } = request.params as { workerId: string; attemptId: string };
    const body = request.body as {
      metadata?: Record<string, unknown>;
    };

    const attempt = await repository.updateAttempt({
      attemptId,
      assignedWorkerId: workerId,
      assignmentMetadataJson: {
        ...(body.metadata ?? {}),
        reportedAt: new Date().toISOString()
      }
    });

    return reply.send({
      ok: true,
      attemptId: attempt.attemptId
    });
  });

  internalApp.get("/workers/:workerId/assignments", async (request, reply) => {
    const { workerId } = request.params as { workerId: string };
    const attempts = await repository.findAttemptsByWorker(workerId);
    return reply.send(
      attempts
        .filter((attempt) => !["completed", "failed", "cancelled", "lost"].includes(attempt.attemptState))
        .map((attempt) => ({
          attemptId: attempt.attemptId,
          taskId: attempt.taskId,
          attemptState: attempt.attemptState,
          assignmentMetadata: attempt.assignmentMetadataJson
        }))
    );
  });

  internalApp.get("/workers", async (_request, reply) => {
    return reply.send(await repository.listWorkers());
  });
}, { prefix: "/internal" });

app.get("/healthz", async (_request, reply) => {
  return reply.send({ ok: true, service: "channelpilot-worker-registry" });
});

app.get("/readyz", async (_request, reply) => {
  await repository.client.$queryRaw`SELECT 1`;
  return reply.send({ ok: true, database: "ready" });
});

app.listen({ host: "0.0.0.0", port: config.WORKER_REGISTRY_PORT }).then(() => {
  logger.info({ port: config.WORKER_REGISTRY_PORT }, "channelpilot worker registry listening");
});
