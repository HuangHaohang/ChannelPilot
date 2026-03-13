import "dotenv/config";
import os from "node:os";
import pino from "pino";
import { FileBackedMockOpenClawStore } from "@channelpilot/openclaw-adapter";
import { loadRuntimeConfig } from "@channelpilot/shared-types";

type MockFlow = "completed" | "waiting_input" | "failed";
type Availability = "idle" | "busy" | "offline";

const config = loadRuntimeConfig(process.env);
const logger = pino({ level: config.LOG_LEVEL });
const store = new FileBackedMockOpenClawStore(config.MOCK_OPENCLAW_STATE_FILE);

const workerId = process.env.MOCK_WORKER_ID ?? `mock-worker-${os.hostname()}`;
const workerLabel = process.env.MOCK_WORKER_LABEL ?? "local-mock-worker";
const workerHost = process.env.MOCK_WORKER_HOST ?? os.hostname();
const flow = (process.env.MOCK_WORKER_FLOW ?? "completed") as MockFlow;
let availability = (process.env.MOCK_WORKER_AVAILABILITY ?? "idle") as Availability;

// step 0 -> accepted, 1 -> running, 2 -> flow-specific branch, 3 -> waiting_input pending resume
const inFlight = new Map<string, number>();

async function registryFetch(path: string, init: RequestInit) {
  const response = await fetch(`${config.WORKER_REGISTRY_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.INTERNAL_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`worker registry request failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function apiFetch(path: string, init: RequestInit) {
  const response = await fetch(`${config.API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.INTERNAL_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`api request failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function updateMockSession(
  attemptId: string,
  nextState: "starting" | "running" | "waiting_input" | "completed" | "failed" | "cancelled",
  summary: string
) {
  await store.mutate(async (state) => {
    const session = Object.values(state.sessions).find((candidate) => candidate.attemptId === attemptId);
    if (!session) {
      return;
    }

    session.state = nextState;
    session.latestSummary = summary;
    session.lastActivityAt = new Date().toISOString();
    session.workerMetadata = {
      ...(session.workerMetadata ?? {}),
      mockWorkerId: workerId,
      mockFlow: flow
    };
  });
}

async function registerWorker() {
  await registryFetch("/internal/workers/register", {
    method: "POST",
    body: JSON.stringify({
      workerId,
      label: workerLabel,
      host: workerHost,
      status: availability === "offline" ? "offline" : "idle",
      capabilities: {
        repos: config.permittedRepos,
        supportsResume: true,
        supportsSteer: true,
        labels: ["mock", "local"]
      },
      metadata: {
        mode: flow,
        mockState: availability
      }
    })
  });
}

async function heartbeat() {
  if (availability === "offline") {
    return;
  }

  await registryFetch(`/internal/workers/${workerId}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({
      status: availability,
      metadata: {
        mockState: availability,
        mockFlow: flow
      }
    })
  });
}

async function processAssignments() {
  if (availability === "offline") {
    return;
  }

  const assignments = (await registryFetch(`/internal/workers/${workerId}/assignments`, {
    method: "GET"
  })) as Array<{ attemptId: string; taskId: string; attemptState: string }>;

  if (assignments.length === 0 && inFlight.size === 0) {
    availability = "idle";
    return;
  }

  if (assignments.length > 0) {
    availability = "busy";
  }

  for (const assignment of assignments) {
    const step = inFlight.get(assignment.attemptId) ?? 0;

    if (step === 0) {
      await apiFetch(`/internal/attempts/${assignment.attemptId}/report`, {
        method: "POST",
        body: JSON.stringify({
          attemptState: "accepted",
          summary: "mock worker 已接受任务。"
        })
      });
      inFlight.set(assignment.attemptId, 1);
      continue;
    }

    if (step === 1) {
      await updateMockSession(assignment.attemptId, "running", "mock worker 正在执行任务。");
      await apiFetch(`/internal/attempts/${assignment.attemptId}/report`, {
        method: "POST",
        body: JSON.stringify({
          attemptState: "running",
          summary: "mock worker 正在执行任务。"
        })
      });
      inFlight.set(assignment.attemptId, 2);
      continue;
    }

    if (flow === "waiting_input" && step === 2) {
      await updateMockSession(assignment.attemptId, "waiting_input", "mock worker 需要人工输入。");
      await apiFetch(`/internal/attempts/${assignment.attemptId}/report`, {
        method: "POST",
        body: JSON.stringify({
          attemptState: "waiting_input",
          summary: "mock worker 需要人工输入。"
        })
      });
      inFlight.set(assignment.attemptId, 3);
      availability = "idle";
      continue;
    }

    if (flow === "waiting_input" && step === 3) {
      if (assignment.attemptState === "waiting_input") {
        availability = "idle";
        continue;
      }
    }

    if (flow === "failed" && step === 2) {
      await updateMockSession(assignment.attemptId, "failed", "mock worker 模拟执行失败。");
      await apiFetch(`/internal/attempts/${assignment.attemptId}/report`, {
        method: "POST",
        body: JSON.stringify({
          attemptState: "failed",
          summary: "mock worker 模拟执行失败。",
          exitCode: 1,
          resultJson: {
            outcome: "failed",
            workerId
          }
        })
      });
      inFlight.delete(assignment.attemptId);
      availability = "idle";
      continue;
    }

    await updateMockSession(assignment.attemptId, "completed", "mock worker 已完成任务。");
    await apiFetch(`/internal/attempts/${assignment.attemptId}/report`, {
      method: "POST",
      body: JSON.stringify({
        attemptState: "completed",
        summary: "mock worker 已完成任务。",
        exitCode: 0,
        resultJson: {
          outcome: "completed",
          workerId
        }
      })
    });
    inFlight.delete(assignment.attemptId);
    availability = "idle";
  }
}

async function boot() {
  await registerWorker();
  await heartbeat();
  await processAssignments();
}

setInterval(() => {
  heartbeat().catch((error) => {
    logger.error({ err: error }, "mock worker heartbeat failed");
  });
}, 5_000);

setInterval(() => {
  processAssignments().catch((error) => {
    logger.error({ err: error }, "mock worker assignment processing failed");
  });
}, 6_000);

boot()
  .then(() => {
    logger.info({ workerId, flow, availability }, "channelpilot mock worker started");
  })
  .catch((error) => {
    logger.error({ err: error }, "mock worker boot failed");
  });
