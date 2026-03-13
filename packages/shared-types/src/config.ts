import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const envSchema = z.object({
  APP_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  INTERNAL_API_TOKEN: z.string().min(1),
  DEFAULT_BACKEND: z.literal("codex").default("codex"),
  LEASE_SECONDS: z.coerce.number().int().positive().default(30),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
  STUCK_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(180),
  CANCEL_GRACE_SECONDS: z.coerce.number().int().positive().default(20),
  MAX_PROGRESS_MESSAGE_FREQUENCY_SECONDS: z.coerce.number().int().positive().default(300),
  WORKSPACE_ROOT: z.string().min(1),
  ARTIFACT_ROOT: z.string().min(1),
  AUTHORIZED_OPERATOR_IDS: z.string().default(""),
  PERMITTED_REPOS: z.string().default(""),
  MOCK_OPENCLAW_STATE_FILE: z.string().default(".data/mock-openclaw-state.json"),
  WORKER_REGISTRY_URL: z.string().url().default("http://localhost:4301"),
  API_BASE_URL: z.string().url().default("http://localhost:4300"),
  API_PORT: z.coerce.number().int().positive().default(4300),
  WORKER_REGISTRY_PORT: z.coerce.number().int().positive().default(4301)
});

export type RuntimeConfig = z.infer<typeof envSchema> & {
  authorizedOperatorIds: string[];
  permittedRepos: string[];
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = envSchema.parse(env);

  return {
    ...parsed,
    MOCK_OPENCLAW_STATE_FILE: path.isAbsolute(parsed.MOCK_OPENCLAW_STATE_FILE)
      ? parsed.MOCK_OPENCLAW_STATE_FILE
      : path.resolve(repoRoot, parsed.MOCK_OPENCLAW_STATE_FILE),
    authorizedOperatorIds: parsed.AUTHORIZED_OPERATOR_IDS.split(",").map((value) => value.trim()).filter(Boolean),
    permittedRepos: parsed.PERMITTED_REPOS.split(",").map((value) => value.trim()).filter(Boolean)
  };
}
