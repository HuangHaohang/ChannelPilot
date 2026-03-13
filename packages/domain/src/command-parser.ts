import crypto from "node:crypto";
import type { IngestChannelMessageInput, NormalizedCommand, TaskOperation } from "@channelpilot/shared-types";

const taskIdPattern = /\bT-\d{8}-\d{5}\b/i;
const repoPattern = /(?:repo|仓库)\s*[:=]?\s*([A-Za-z0-9._/-]+)/i;

function buildIdempotencyKey(input: IngestChannelMessageInput): string {
  if (input.idempotencyKey) {
    return input.idempotencyKey;
  }

  const hash = crypto.createHash("sha256");
  hash.update(`${input.channel}:${input.accountId}:${input.threadKey}:${input.sourceMessageId}`);
  return hash.digest("hex");
}

function detectOperation(text: string): TaskOperation {
  const normalized = text.trim().toLowerCase();

  if (normalized.startsWith("让 codex") || normalized.startsWith("请让 codex") || normalized.startsWith("请 codex") || normalized.includes("repo ")) {
    return "run";
  }
  if (normalized.startsWith("/help") || normalized === "help") return "help";
  if (normalized.startsWith("/status") || normalized.includes("状态") || normalized.includes("进度") || normalized.includes("status")) return "status";
  if (normalized.startsWith("/stop") || normalized.includes("停掉") || normalized.includes("停止") || normalized.includes("cancel")) return "stop";
  if (normalized.startsWith("/resume") || normalized.startsWith("/continue")) return "resume";
  if (normalized.startsWith("/summary") || normalized.startsWith("/summarize") || normalized.includes("总结")) return "summarize";
  if (normalized.startsWith("/steer")) return "steer";
  if (normalized.startsWith("/run")) return "run";

  if (normalized.includes("继续") || normalized.includes("不要") || normalized.includes("优先") || normalized.includes("先跑")) {
    return normalized === "继续" || normalized === "恢复" ? "resume" : "steer";
  }

  return "run";
}

function extractConstraints(text: string): string[] {
  const constraints = new Set<string>();
  const patterns = [/不要([^，。,.]+)/g, /先([^，。,.]+)/g, /只([^，。,.]+)/g];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[0].trim();
      if (value) constraints.add(value);
    }
  }

  return [...constraints];
}

function stripCommandPrefix(text: string): string {
  return text
    .replace(/^\/(run|status|steer|stop|resume|continue|summary|summarize|help)\s*/i, "")
    .replace(/^(让|请让|请|帮我让)\s*codex\s*/i, "")
    .trim();
}

export function normalizeCommand(input: IngestChannelMessageInput): NormalizedCommand {
  const op = detectOperation(input.text);
  const taskIdMatch = input.text.match(taskIdPattern);
  const repoMatch = input.text.match(repoPattern);

  return {
    op,
    backend: "codex",
    goal: op === "run" ? stripCommandPrefix(input.text) : undefined,
    repo: repoMatch?.[1],
    taskId: taskIdMatch?.[0]?.toUpperCase(),
    threadKey: input.threadKey,
    requesterId: input.requesterId,
    idempotencyKey: buildIdempotencyKey(input),
    sourceMessageId: input.sourceMessageId,
    constraints: extractConstraints(input.text),
    rawText: input.text
  };
}
