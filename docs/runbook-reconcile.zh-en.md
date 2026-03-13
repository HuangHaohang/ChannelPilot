# Reconcile Runbook / Reconcile 操作手册

## 中文说明

### Stale Task

1. 检查 `task.state`、`updated_at`、`state_version`。
2. 检查 lease 是否过期。
3. 查询 worker heartbeat。
4. 查询 adapter session snapshot。
5. 若 worker 与 session 都不可确认，则转 `lost`。
6. 若 session 仍活着且 task 为 `lost`，则恢复到 `running`。

### Lost Task

1. 保留所有 artifacts、events、inbound messages 与 audit logs。
2. 向 outbox 写入系统通知。
3. 允许 `lost -> running | failed | cancelled | blocked`。

## English Summary

### Stale Task

1. Inspect `task.state`, `updated_at`, and `state_version`.
2. Check whether the lease has expired.
3. Check worker heartbeats.
4. Inspect the adapter session snapshot.
5. Mark the task as `lost` only if both worker truth and session truth are unavailable.
6. Recover `lost -> running` if the session is confirmed alive again.

### Lost Task

1. Preserve artifacts, events, inbound messages, and audit logs.
2. Enqueue a system notification in the outbox.
3. Only allow `lost -> running | failed | cancelled | blocked`.
