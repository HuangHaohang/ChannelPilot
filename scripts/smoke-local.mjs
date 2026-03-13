import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.join(repoRoot, ".data", "mock-openclaw-state.json");
const reportFile = path.join(repoRoot, ".data", "smoke-local-report.json");

const noActiveTaskMessage = "\u5f53\u524d thread \u6ca1\u6709\u8fdb\u884c\u4e2d\u7684\u4e3b\u4efb\u52a1";
const activeTaskExistsMessage = "\u5f53\u524d thread \u5df2\u6709\u8fdb\u884c\u4e2d\u7684\u4e3b\u4efb\u52a1";
const resumeSummary = "\u5df2\u6062\u590d\u6267\u884c\u3002";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvFile(contents) {
  const parsed = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    parsed[key] = value;
  }

  return parsed;
}

async function loadRuntimeSettings() {
  const envText = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
  const parsed = parseEnvFile(envText);

  return {
    apiBaseUrl: parsed.API_BASE_URL ?? "http://localhost:4300",
    internalApiToken: parsed.INTERNAL_API_TOKEN ?? "channelpilot-internal-token",
    requesterId: parsed.AUTHORIZED_OPERATOR_IDS?.split(",").map((value) => value.trim()).filter(Boolean)[0] ?? "telegram:uid:123456",
    repo: parsed.PERMITTED_REPOS?.split(",").map((value) => value.trim()).filter(Boolean)[0] ?? "payments"
  };
}

function runCommand(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stderr || stdout}`));
    });
  });
}

async function dockerCompose(...args) {
  return runCommand("docker", ["compose", ...args]);
}

async function dockerComposeCapture(...args) {
  return runCommand("docker", ["compose", ...args], { capture: true });
}

async function sql(query) {
  const { stdout } = await dockerComposeCapture(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "channelpilot",
    "-At",
    "-F",
    "\t",
    "-c",
    query
  );

  return stdout.trim();
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function httpJson(method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    payload
  };
}

async function waitFor(label, predicate, { timeoutMs = 90_000, intervalMs = 1_000 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate();
    if (result) {
      return result;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludes(haystack, needle, label) {
  assert(typeof haystack === "string" && haystack.includes(needle), `${label} did not include expected text: ${needle}`);
}

async function ingest(settings, threadKey, sourceMessageId, text) {
  const response = await httpJson("POST", `${settings.apiBaseUrl}/ingest/channel-message`, {
    channel: "telegram",
    accountId: "smoke-local",
    threadKey,
    requesterId: settings.requesterId,
    sourceMessageId,
    text
  });

  assert(response.ok, `ingest failed for ${text}: ${JSON.stringify(response.payload)}`);
  return response.payload;
}

async function getTask(settings, taskId) {
  const response = await httpJson("GET", `${settings.apiBaseUrl}/tasks/${encodeURIComponent(taskId)}`);
  assert(response.ok, `get task failed: ${taskId}`);
  return response.payload;
}

async function getThreadView(settings, threadKey) {
  const response = await httpJson("GET", `${settings.apiBaseUrl}/threads/${encodeURIComponent(threadKey)}`);
  assert(response.ok, `get thread view failed: ${threadKey}`);
  return response.payload;
}

async function getWorkers(settings) {
  const response = await httpJson("GET", `${settings.apiBaseUrl}/workers`);
  assert(response.ok, "get workers failed");
  return response.payload;
}

async function reportAttempt(settings, attemptId, body) {
  const response = await httpJson(
    "POST",
    `${settings.apiBaseUrl}/internal/attempts/${encodeURIComponent(attemptId)}/report`,
    body,
    {
      Authorization: `Bearer ${settings.internalApiToken}`
    }
  );

  assert(response.ok, `report attempt failed: ${attemptId}`);
  return response.payload;
}

async function getTaskRow(taskId) {
  const row = await sql(`
    SELECT
      state,
      state_version::text,
      COALESCE(last_summary, ''),
      COALESCE(current_attempt_id, '')
    FROM tasks
    WHERE task_id = ${sqlString(taskId)}
  `);

  const [state, stateVersion, lastSummary, currentAttemptId] = row.split("\t");
  return { state, stateVersion, lastSummary, currentAttemptId };
}

async function getAttemptRow(attemptId) {
  const row = await sql(`
    SELECT
      attempt_state,
      COALESCE(exit_code::text, ''),
      CASE WHEN ended_at IS NULL THEN 'null' ELSE 'set' END
    FROM task_attempts
    WHERE attempt_id = ${sqlString(attemptId)}
  `);

  const [attemptState, exitCode, endedAt] = row.split("\t");
  return { attemptState, exitCode, endedAt };
}

async function getOutboxRows(taskId) {
  const rows = await sql(`
    SELECT
      notification_kind,
      status,
      state_version::text
    FROM notification_outbox
    WHERE task_id = ${sqlString(taskId)}
    ORDER BY created_at ASC
  `);

  if (!rows) {
    return [];
  }

  return rows.split(/\r?\n/).map((line) => {
    const [notificationKind, status, stateVersion] = line.split("\t");
    return { notificationKind, status, stateVersion };
  });
}

async function getEventTypes(taskId) {
  const rows = await sql(`
    SELECT event_type
    FROM task_events
    WHERE task_id = ${sqlString(taskId)}
    ORDER BY event_id ASC
  `);

  return rows ? rows.split(/\r?\n/) : [];
}

async function getReplyCount(taskId) {
  try {
    const stateText = await fs.readFile(stateFile, "utf8");
    const state = JSON.parse(stateText);
    return state.replies.filter((reply) => reply.taskId === taskId).length;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }

    throw error;
  }
}

function makeThreadKey(caseName) {
  return `telegram:-100:topic:smoke-${caseName}-${Date.now()}`;
}

async function waitForTaskState(settings, taskId, expectedState) {
  return waitFor(`task ${taskId} -> ${expectedState}`, async () => {
    const task = await getTask(settings, taskId);
    return task.state === expectedState ? task : null;
  });
}

async function waitForThreadState(settings, threadKey, expectedState) {
  return waitFor(`thread ${threadKey} -> ${expectedState}`, async () => {
    const thread = await getThreadView(settings, threadKey);
    return thread.publicState === expectedState ? thread : null;
  });
}

async function waitForOutboxKinds(taskId, expectedKinds) {
  return waitFor(`outbox kinds for ${taskId}`, async () => {
    const rows = await getOutboxRows(taskId);
    const deliveredKinds = rows.filter((row) => row.status === "delivered").map((row) => row.notificationKind);
    return expectedKinds.every((kind) => deliveredKinds.includes(kind)) ? rows : null;
  });
}

async function waitForTaskAttemptState(settings, taskId, expectedTaskState, expectedAttemptState) {
  return waitFor(`task ${taskId} and current attempt -> ${expectedTaskState}/${expectedAttemptState}`, async () => {
    const task = await getTask(settings, taskId);
    return task.state === expectedTaskState && task.attempt?.attemptState === expectedAttemptState ? task : null;
  });
}

async function resetEnvironment() {
  await dockerCompose("down", "-v", "--remove-orphans");
  await fs.rm(stateFile, { force: true });
  await fs.rm(reportFile, { force: true });
}

async function removeIgnoredLinks() {
  const roots = [path.join(repoRoot, "packages"), path.join(repoRoot, "services")];
  const removeIgnoredEntry = async (fullPath) => {
    fsSync.rmSync(fullPath, { recursive: true, force: true });
  };

  async function cleanIgnoredEntries(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.name.startsWith(".ignored_")) {
        await removeIgnoredEntry(fullPath);
        continue;
      }
    }
  }

  for (const root of roots) {
    const packageEntries = await fs.readdir(root, { withFileTypes: true });
    for (const packageEntry of packageEntries) {
      if (!packageEntry.isDirectory()) {
        continue;
      }

      const packageDir = path.join(root, packageEntry.name);
      const nodeModulesDir = path.join(packageDir, "node_modules");
      await cleanIgnoredEntries(nodeModulesDir);

      const scopedDir = path.join(nodeModulesDir, "@channelpilot");
      await cleanIgnoredEntries(scopedDir);
      await cleanIgnoredEntries(path.join(nodeModulesDir, "@prisma"));
    }
  }
}

async function restoreHostWorkspace() {
  console.log("Restoring host workspace dependencies...");
  await removeIgnoredLinks();
  if (process.platform === "win32") {
    await runCommand("cmd", ["/c", "pnpm", "install"]);
    return;
  }

  await runCommand("pnpm", ["install"]);
}

async function startStack() {
  await dockerCompose("up", "-d");
}

async function waitForStack(settings) {
  await waitFor("api ready", async () => {
    const response = await httpJson("GET", `${settings.apiBaseUrl}/readyz`);
    return response.ok;
  });

  await waitFor("worker registry ready", async () => {
    const response = await httpJson("GET", "http://localhost:4301/readyz");
    return response.ok;
  });

  await waitFor("mock worker registration", async () => {
    const workers = await getWorkers(settings);
    return Array.isArray(workers) && workers.length > 0 ? workers : null;
  });
}

async function runSmoke() {
  const settings = await loadRuntimeSettings();
  const report = {
    generatedAt: new Date().toISOString(),
    cases: []
  };

  console.log("Resetting local stack...");
  await resetEnvironment();
  console.log("Starting docker compose...");
  await startStack();
  console.log("Waiting for services...");
  await waitForStack(settings);

  const happyThread = makeThreadKey("run");
  const happyRun = await ingest(settings, happyThread, "msg-run-1", `/run repo ${settings.repo} finish the happy-path smoke run`);
  assert(happyRun.accepted === true && happyRun.taskId, "run happy path did not create a task");
  const happyTask = await waitForTaskState(settings, happyRun.taskId, "completed");
  const happyOutbox = await waitForOutboxKinds(happyRun.taskId, ["receipt", "final"]);
  const happyReplies = await waitFor("notifier replies for happy path", async () => {
    const replyCount = await getReplyCount(happyRun.taskId);
    return replyCount >= 2 ? replyCount : null;
  });
  assert(happyTask.attempt?.attemptState === "completed", "happy-path attempt did not finish as completed");
  report.cases.push({
    name: "run",
    expected: "create a task from /run and let the default mock worker drive it to completed",
    actual: {
      taskId: happyRun.taskId,
      taskState: happyTask.state,
      attemptState: happyTask.attempt?.attemptState ?? null,
      outbox: happyOutbox,
      replies: happyReplies
    }
  });

  const activeThread = makeThreadKey("active");
  const activeRun = await ingest(settings, activeThread, "msg-active-1", `/run repo ${settings.repo} keep an active task for status and steer smoke`);
  assert(activeRun.accepted === true && activeRun.taskId, "active task setup failed");
  const outboxCountBeforeStatus = Number(await sql(`SELECT COUNT(*) FROM notification_outbox WHERE task_id = ${sqlString(activeRun.taskId)}`));
  const statusOnActive = await ingest(settings, activeThread, "msg-active-2", "/status");
  const steerOnActive = await ingest(settings, activeThread, "msg-active-3", "/steer run tests first");
  const statusAfterSteer = await ingest(settings, activeThread, "msg-active-4", "/status");
  const outboxCountAfterStatus = Number(await sql(`SELECT COUNT(*) FROM notification_outbox WHERE task_id = ${sqlString(activeRun.taskId)}`));
  const runRejected = await ingest(settings, activeThread, "msg-active-5", `/run repo ${settings.repo} should be rejected while active`);
  assert(statusOnActive.accepted === true && statusOnActive.taskId === activeRun.taskId, "status did not target the active main task");
  assert(steerOnActive.accepted === true && steerOnActive.taskId === activeRun.taskId, "steer did not target the active main task");
  assert(statusAfterSteer.accepted === true && statusAfterSteer.taskId === activeRun.taskId, "status after steer missed the active task");
  assert(outboxCountBeforeStatus === outboxCountAfterStatus, "status should not create additional outbox rows");
  assert(runRejected.accepted === false, "run should be rejected while an active main task exists");
  assertIncludes(runRejected.messageForOperator, activeTaskExistsMessage, "run rejection");
  report.cases.push({
    name: "status-steer-run-rejection",
    expected: "status and steer default to the active main task, status does not add outbox noise, and a second /run is rejected",
    actual: {
      taskId: activeRun.taskId,
      statusTaskId: statusOnActive.taskId,
      steerTaskId: steerOnActive.taskId,
      statusTaskIdAfterSteer: statusAfterSteer.taskId,
      outboxCountBeforeStatus,
      outboxCountAfterStatus,
      runRejectedMessage: runRejected.messageForOperator
    }
  });

  console.log("Stopping mock worker to avoid races in deterministic command-edge scenarios...");
  await dockerCompose("stop", "channelpilot-mock-worker");

  for (const [commandText, caseName] of [
    ["/status", "status-no-active"],
    ["/steer investigate current state", "steer-no-active"],
    ["/stop", "stop-no-active"],
    ["/resume", "resume-no-active"]
  ]) {
    const threadKey = makeThreadKey(caseName);
    const response = await ingest(settings, threadKey, `msg-${caseName}`, commandText);
    assert(response.accepted === false, `${caseName} should have been rejected`);
    assertIncludes(response.messageForOperator, noActiveTaskMessage, `${caseName} rejection`);
    report.cases.push({
      name: caseName,
      expected: `${commandText} should fail clearly when the thread has no active main task`,
      actual: {
        accepted: response.accepted,
        message: response.messageForOperator
      }
    });
  }

  const stopThread = makeThreadKey("stop");
  const stopRun = await ingest(settings, stopThread, "msg-stop-1", `/run repo ${settings.repo} verify cancelling to cancelled`);
  assert(stopRun.accepted === true && stopRun.taskId, "stop scenario task creation failed");
  const stopTaskBeforeStop = await getTask(settings, stopRun.taskId);
  assert(stopTaskBeforeStop.currentAttemptId, "stop scenario is missing a current attempt");
  const stopCommand = await ingest(settings, stopThread, "msg-stop-2", "/stop");
  assert(stopCommand.accepted === true, "stop command was not accepted");
  assertIncludes(stopCommand.messageForOperator, "\u6b63\u5728\u53d6\u6d88", "stop receipt");
  await reportAttempt(settings, stopTaskBeforeStop.currentAttemptId, {
    attemptState: "cancelled",
    summary: "smoke stop path reached cancelled"
  });
  const cancelledTask = await waitForTaskState(settings, stopRun.taskId, "cancelled");
  const cancelledAttempt = await getAttemptRow(stopTaskBeforeStop.currentAttemptId);
  const cancelledEvents = await getEventTypes(stopRun.taskId);
  assert(cancelledAttempt.attemptState === "cancelled", "stop scenario attempt did not reach cancelled");
  assert(cancelledEvents.includes("STOP_REQUESTED"), "stop scenario is missing STOP_REQUESTED");
  assert(cancelledEvents.includes("TASK_CANCELLED"), "stop scenario is missing TASK_CANCELLED");
  report.cases.push({
    name: "stop",
    expected: "/stop should move the task into cancelling and then cancelled",
    actual: {
      taskId: stopRun.taskId,
      taskState: cancelledTask.state,
      attemptState: cancelledAttempt.attemptState,
      eventTypes: cancelledEvents
    }
  });

  const resumeThread = makeThreadKey("resume");
  const resumeRun = await ingest(settings, resumeThread, "msg-resume-1", `/run repo ${settings.repo} verify waiting input resume closure`);
  assert(resumeRun.accepted === true && resumeRun.taskId, "resume scenario task creation failed");
  const resumeTaskInitial = await getTask(settings, resumeRun.taskId);
  assert(resumeTaskInitial.currentAttemptId, "resume scenario is missing a current attempt");
  await reportAttempt(settings, resumeTaskInitial.currentAttemptId, {
    attemptState: "waiting_input",
    summary: "smoke waiting for operator input"
  });
  const waitingThread = await waitForThreadState(settings, resumeThread, "waiting_input");
  const waitingAttempt = await getAttemptRow(resumeTaskInitial.currentAttemptId);
  assert(waitingAttempt.attemptState === "waiting_input", "resume scenario did not reach waiting_input");
  const resumeCommand = await ingest(settings, resumeThread, "msg-resume-2", "/resume");
  assert(resumeCommand.accepted === true, "resume command was not accepted");
  assertIncludes(resumeCommand.messageForOperator, resumeSummary, "resume receipt");
  const resumedTask = await waitForTaskAttemptState(settings, resumeRun.taskId, "running", "running");
  const resumedThread = await waitForThreadState(settings, resumeThread, "running");
  assert(resumedThread.lastSummary === resumeSummary, "thread view did not expose the resume summary");
  await reportAttempt(settings, resumeTaskInitial.currentAttemptId, {
    attemptState: "completed",
    summary: "smoke resume path completed"
  });
  const completedAfterResume = await waitForTaskState(settings, resumeRun.taskId, "completed");
  const resumeOutbox = await waitForOutboxKinds(resumeRun.taskId, ["receipt", "waiting_input", "progress", "final"]);
  const resumeEvents = await getEventTypes(resumeRun.taskId);
  const resumeTaskRow = await getTaskRow(resumeRun.taskId);
  const resumeAttempt = await getAttemptRow(resumeTaskInitial.currentAttemptId);
  assert(resumeEvents.includes("RESUME_REQUESTED"), "resume scenario is missing RESUME_REQUESTED");
  assert(resumeTaskRow.state === "completed", "resume scenario task row did not complete");
  assert(resumeAttempt.attemptState === "completed", "resume scenario attempt row did not complete");
  report.cases.push({
    name: "resume",
    expected: "waiting_input should resume back to running without manual DB edits, then complete cleanly",
    actual: {
      taskId: resumeRun.taskId,
      waitingThreadState: waitingThread.publicState,
      resumedTaskState: resumedTask.state,
      resumedAttemptState: resumedTask.attempt?.attemptState ?? null,
      resumedThreadState: resumedThread.publicState,
      resumedThreadSummary: resumedThread.lastSummary,
      finalTaskState: completedAfterResume.state,
      finalAttemptState: resumeAttempt.attemptState,
      outbox: resumeOutbox,
      eventTypes: resumeEvents
    }
  });

  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2), "utf8");

  console.log(`Smoke report written to ${path.relative(repoRoot, reportFile)}`);
  console.log(JSON.stringify(report, null, 2));
}

try {
  await runSmoke();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  await restoreHostWorkspace();
}
