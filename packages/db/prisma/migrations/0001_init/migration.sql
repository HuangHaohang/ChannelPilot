CREATE TYPE "TaskState" AS ENUM (
  'queued',
  'starting',
  'binding',
  'running',
  'waiting_input',
  'blocked',
  'cancelling',
  'summarizing',
  'completed',
  'failed',
  'cancelled',
  'lost'
);

CREATE TYPE "TaskDesiredState" AS ENUM ('none', 'running', 'cancelled', 'blocked');
CREATE TYPE "TaskKind" AS ENUM ('main', 'follow_up');
CREATE TYPE "AttemptState" AS ENUM ('created', 'assigned', 'accepted', 'running', 'waiting_input', 'completed', 'failed', 'cancelled', 'lost');
CREATE TYPE "TaskEventType" AS ENUM (
  'TASK_CREATED',
  'COMMAND_NORMALIZED',
  'TASK_ACCEPTED',
  'STATE_TRANSITIONED',
  'THREAD_BOUND',
  'SESSION_SPAWNED',
  'SESSION_REUSED',
  'SESSION_STATUS_SYNCED',
  'STEER_ACCEPTED',
  'STOP_REQUESTED',
  'RESUME_REQUESTED',
  'WORKER_ASSIGNED',
  'WORKER_HEARTBEAT_RECORDED',
  'WORKER_MARKED_LOST',
  'NOTIFICATION_ENQUEUED',
  'NOTIFICATION_DELIVERED',
  'NOTIFICATION_FAILED',
  'RECONCILIATION_APPLIED',
  'TASK_MARKED_LOST',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'TASK_CANCELLED'
);
CREATE TYPE "WorkerStatus" AS ENUM ('idle', 'busy', 'offline', 'lost');
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'delivering', 'delivered', 'failed', 'dead_letter');
CREATE TYPE "NotificationKind" AS ENUM ('receipt', 'progress', 'waiting_input', 'final', 'system');

CREATE TABLE "tasks" (
  "task_id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "requested_goal" TEXT NOT NULL,
  "backend" TEXT NOT NULL,
  "state" "TaskState" NOT NULL,
  "desired_state" "TaskDesiredState" NOT NULL DEFAULT 'none',
  "state_version" BIGINT NOT NULL DEFAULT 0,
  "requester_id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "thread_key" TEXT NOT NULL,
  "repo" TEXT,
  "cwd" TEXT,
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "task_kind" "TaskKind" NOT NULL DEFAULT 'main',
  "current_attempt_id" TEXT,
  "last_summary" TEXT,
  "last_emitted_summary" TEXT,
  "last_notified_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completed_at" TIMESTAMPTZ
);

CREATE TABLE "task_attempts" (
  "attempt_id" TEXT PRIMARY KEY,
  "task_id" TEXT NOT NULL REFERENCES "tasks"("task_id"),
  "worker_type" TEXT NOT NULL,
  "worker_host" TEXT,
  "acp_session_id" TEXT,
  "acp_session_key" TEXT,
  "binding_key" TEXT,
  "assigned_worker_id" TEXT,
  "attempt_state" "AttemptState" NOT NULL DEFAULT 'created',
  "assignment_metadata_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "ended_at" TIMESTAMPTZ,
  "exit_code" INTEGER,
  "result_json" JSONB
);

CREATE TABLE "task_events" (
  "event_id" BIGSERIAL PRIMARY KEY,
  "task_id" TEXT NOT NULL REFERENCES "tasks"("task_id"),
  "attempt_id" TEXT,
  "event_type" "TaskEventType" NOT NULL,
  "source" TEXT NOT NULL,
  "reason" TEXT,
  "payload_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "task_artifacts" (
  "artifact_id" BIGSERIAL PRIMARY KEY,
  "task_id" TEXT NOT NULL REFERENCES "tasks"("task_id"),
  "attempt_id" TEXT,
  "kind" TEXT NOT NULL,
  "path_or_url" TEXT NOT NULL,
  "metadata_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "task_leases" (
  "task_id" TEXT PRIMARY KEY REFERENCES "tasks"("task_id"),
  "lease_owner" TEXT NOT NULL,
  "lease_token" TEXT NOT NULL,
  "lease_until" TIMESTAMPTZ NOT NULL,
  "heartbeat_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE "openclaw_threads" (
  "thread_key" TEXT PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "external_thread_id" TEXT,
  "current_task_id" TEXT,
  "current_binding_key" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "workers" (
  "worker_id" TEXT PRIMARY KEY,
  "label" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "capabilities_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "metadata_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" "WorkerStatus" NOT NULL DEFAULT 'idle',
  "last_seen_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "ingest_idempotency" (
  "record_id" TEXT PRIMARY KEY,
  "idempotency_key" TEXT NOT NULL,
  "requester_id" TEXT NOT NULL,
  "thread_key" TEXT NOT NULL,
  "task_id" TEXT,
  "response_json" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "inbound_messages" (
  "message_id" TEXT PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "thread_key" TEXT NOT NULL,
  "requester_id" TEXT NOT NULL,
  "source_message_id" TEXT NOT NULL,
  "raw_payload_json" JSONB NOT NULL,
  "normalized_command_json" JSONB NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "task_id" TEXT REFERENCES "tasks"("task_id"),
  "processing_result" TEXT NOT NULL,
  "processed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "notification_outbox" (
  "notification_id" TEXT PRIMARY KEY,
  "task_id" TEXT NOT NULL REFERENCES "tasks"("task_id"),
  "thread_key" TEXT NOT NULL,
  "notification_kind" "NotificationKind" NOT NULL,
  "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
  "dedupe_key" TEXT NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ NOT NULL,
  "last_error" TEXT,
  "delivered_at" TIMESTAMPTZ,
  "claimed_by" TEXT,
  "claimed_at" TIMESTAMPTZ,
  "payload_json" JSONB NOT NULL,
  "state_version" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "audit_logs" (
  "audit_id" BIGSERIAL PRIMARY KEY,
  "actor_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "payload_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_attempt_id_fk" FOREIGN KEY ("current_attempt_id") REFERENCES "task_attempts"("attempt_id");
ALTER TABLE "openclaw_threads" ADD CONSTRAINT "openclaw_threads_current_task_id_fk" FOREIGN KEY ("current_task_id") REFERENCES "tasks"("task_id");
ALTER TABLE "ingest_idempotency" ADD CONSTRAINT "ingest_idempotency_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("task_id");

CREATE UNIQUE INDEX "ingest_idempotency_dedupe_key" ON "ingest_idempotency" ("idempotency_key", "requester_id", "thread_key");
CREATE UNIQUE INDEX "inbound_messages_source_message_unique" ON "inbound_messages" ("channel", "account_id", "thread_key", "source_message_id");
CREATE UNIQUE INDEX "notification_outbox_dedupe_key_key" ON "notification_outbox" ("dedupe_key");

CREATE INDEX "tasks_thread_key_state_idx" ON "tasks" ("thread_key", "state");
CREATE INDEX "task_events_task_id_created_at_idx" ON "task_events" ("task_id", "created_at");
CREATE INDEX "task_leases_lease_until_idx" ON "task_leases" ("lease_until");
CREATE INDEX "workers_last_seen_at_idx" ON "workers" ("last_seen_at");
CREATE INDEX "inbound_messages_thread_key_processed_at_idx" ON "inbound_messages" ("thread_key", "processed_at");
CREATE INDEX "notification_outbox_status_next_attempt_at_idx" ON "notification_outbox" ("status", "next_attempt_at");

CREATE UNIQUE INDEX "tasks_single_active_main_task_per_thread_idx"
  ON "tasks" ("thread_key")
  WHERE "task_kind" = 'main'
    AND "state" IN ('queued', 'starting', 'binding', 'running', 'waiting_input', 'blocked', 'summarizing', 'lost', 'cancelling');
