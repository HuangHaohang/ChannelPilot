# 本地 Smoke / Local Smoke

## 中文说明

### 目标

把命令级本地 Docker smoke 固化成一套“完全无手工干预”的固定流程，覆盖以下闭环：

- `run`
- `status`
- `steer`
- `stop`
- `resume`
- `run` 被 active main task 拒绝
- 无 active main task 时 `status / steer / stop / resume` 的明确错误
- `cancelling -> cancelled`
- `waiting_input -> resume -> running -> completed`

### 固定执行方式

执行入口：

```bash
pnpm smoke:local
```

或：

```bash
pnpm test:integration
```

脚本位置：

- `scripts/smoke-local.mjs`

脚本输出：

- 终端打印完整断言结果
- 结构化报告写入 `.data/smoke-local-report.json`

### 固定操作流

脚本会自动完成以下步骤，不需要手工改数据库，也不需要手工重启单个服务：

1. `docker compose down -v --remove-orphans`
2. 删除仓库根目录 `.data/mock-openclaw-state.json`
3. `docker compose up -d`
4. 等待 `api`、`worker-registry` 和默认 `mock-worker` 就绪
5. 用 `POST /ingest/channel-message` 驱动 `run / status / steer / stop / resume`
6. 通过 `GET /tasks/:taskId`、`GET /threads/:threadKey`、PostgreSQL 查询和 mock adapter 状态文件做断言
7. 在需要确定性边界条件时，使用 `POST /internal/attempts/:attemptId/report` 注入 worker 回报
8. 在边界场景前自动停止 `channelpilot-mock-worker`，避免与默认 completed flow 竞争
9. 结束后自动清理 Docker 侧生成的 `.ignored_*` 软链并恢复宿主机 `pnpm install`

说明：

- 命令入口尽量统一走 `POST /ingest/channel-message`
- 只有 worker 回报这一步使用内部接口做确定性控制
- 全流程不依赖手工 SQL、手工改 `attempt_state`、手工修 `task state`

### 本轮实际运行结果

运行时间：

- 2026-03-14 04:22:53 CST

运行命令：

```bash
pnpm smoke:local
```

#### 覆盖结果

| 用例 | 固定步骤 | 预期结果 | 本次实际结果 |
| --- | --- | --- | --- |
| `run` | 在新 thread 发送 `/run repo payments finish the happy-path smoke run` | 创建任务，并由默认 mock worker 推进到 `completed` | 任务 `T-20260313-92549` 达到 `completed`，attempt 为 `completed`；outbox 中 `receipt@v3`、`final@v5` 都是 `delivered`；mock adapter 回帖 2 条 |
| `status` | 在 active task 所在线程发送 `/status` 两次 | 两次都默认命中当前 active main task；不新增 outbox 噪音 | 两次都命中 `T-20260313-78662`；outbox 条数保持 `1 -> 1` |
| `steer` | 在同一 active task 线程发送 `/steer run tests first` | 默认命中当前 active main task | `steer` 命中 `T-20260313-78662`，后续 `/status` 仍命中同一任务 |
| `run` 拒绝 | 在已有 active main task 的线程再次发送 `/run` | 明确拒绝，不创建第二个 active main task | 返回“当前 thread 已有进行中的主任务。请使用 steer / stop / summarize，或等待当前任务结束后再创建新任务。” |
| `status` 无 active task | 在空线程发送 `/status` | 明确拒绝 | 返回“当前 thread 没有进行中的主任务。请先创建任务，或显式提供 taskId。” |
| `steer` 无 active task | 在空线程发送 `/steer investigate current state` | 明确拒绝 | 返回“当前 thread 没有进行中的主任务。请先创建任务，或显式提供 taskId。” |
| `stop` 无 active task | 在空线程发送 `/stop` | 明确拒绝 | 返回“当前 thread 没有进行中的主任务。请先创建任务，或显式提供 taskId。” |
| `resume` 无 active task | 在空线程发送 `/resume` | 明确拒绝 | 返回“当前 thread 没有进行中的主任务。请先创建任务，或显式提供 taskId。” |
| `cancelling -> cancelled` | 创建任务后发送 `/stop`，再通过内部 worker report 回报 `cancelled` | task 和 attempt 一起到 `cancelled` | 任务 `T-20260313-05417` 到 `cancelled`，attempt 同步为 `cancelled`；事件包含 `STOP_REQUESTED`、`TASK_CANCELLED` |
| `waiting_input -> resume -> running -> completed` | 创建任务后通过内部 worker report 注入 `waiting_input`，发送 `/resume`，再回报 `completed` | `resume` 成功后 task 与 attempt 同步回 `running`，最终到 `completed` | 任务 `T-20260313-68614` 在 `waiting_input` 后恢复；`resumedTaskState=running`、`resumedAttemptState=running`；thread view 为 `running` 且 `lastSummary=已恢复执行。`；最终 task/attempt 都为 `completed`；outbox 中 `receipt@v3`、`waiting_input@v4`、`progress@v5`、`final@v7` 全部 `delivered`；事件包含 `RESUME_REQUESTED` |

### 结论

- `resume` 闭环已经无需手工改库
- `task state` 与 `attempt_state` 在 `resume` 成功后会一致推进
- 线程视图、摘要、事件、outbox 在 `waiting_input -> resume -> running -> completed` 路径上已对齐
- 本地 Docker smoke 已经可以重复执行，并且这次实际跑通

## English Summary

### Goal

Make the local Docker smoke fully repeatable and zero-manual-intervention, covering:

- `run`
- `status`
- `steer`
- `stop`
- `resume`
- `run` rejection while an active main task already exists
- clear errors for `status / steer / stop / resume` when there is no active main task
- `cancelling -> cancelled`
- `waiting_input -> resume -> running -> completed`

### Fixed Flow

Run:

```bash
pnpm smoke:local
```

or:

```bash
pnpm test:integration
```

Implementation:

- script: `scripts/smoke-local.mjs`
- report artifact: `.data/smoke-local-report.json`

The script automatically:

1. tears the stack down with volumes,
2. clears the shared mock adapter state file,
3. starts `docker compose`,
4. waits for API, worker-registry, and the default mock worker,
5. drives commands through `POST /ingest/channel-message`,
6. verifies state through API, PostgreSQL, and the mock adapter state file,
7. uses `POST /internal/attempts/:attemptId/report` only for deterministic worker-state injection,
8. stops the mock worker before edge-path cases to remove races,
9. restores host-side workspace dependencies after the smoke run so local `pnpm test` and `pnpm typecheck` remain usable.

No manual database edits are required.

### Actual Run

Run time:

- 2026-03-14 04:22:53 CST

Observed results:

- `run`: `T-20260313-92549` reached `completed`; the attempt also reached `completed`; `receipt@v3` and `final@v5` were both delivered.
- `status` and `steer`: both defaulted to active task `T-20260313-78662`; `/status` did not add outbox rows (`1 -> 1`).
- `run` rejection: the active-thread retry returned the expected “active main task already exists” message.
- no-active-task errors: `status / steer / stop / resume` all returned the expected “no active main task” error.
- `stop`: `T-20260313-05417` moved cleanly to `cancelled`; the attempt also became `cancelled`; events included `STOP_REQUESTED` and `TASK_CANCELLED`.
- `resume`: `T-20260313-68614` moved from `waiting_input` back to `running` without any manual DB edit; both task and attempt then reached `completed`; the thread view exposed `lastSummary=已恢复执行。`; outbox rows `receipt@v3`, `waiting_input@v4`, `progress@v5`, and `final@v7` were all delivered.
