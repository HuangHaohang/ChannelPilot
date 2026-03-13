# 假设说明 / Assumptions

## 中文说明

- v1 的 worker coordination 是 contract-first。
- `local mock worker` 仅用于开发与测试，不代表生产执行器。
- 真实执行链路当前通过 OpenClaw adapter 对接。
- OpenClaw 的私有 ACP/session 细节仍需在真实接入时验证，因此全部被隔离在 `packages/openclaw-adapter` 内。
- Prisma 负责 schema 与 migration；partial unique index 通过 raw SQL migration 落地。
- v1 默认不做物理删除，保留 retention policy 扩展位。

## English Summary

- v1 worker coordination is contract-first.
- The local mock worker is for development and testing only.
- The real execution path is currently integrated through the OpenClaw adapter.
- OpenClaw-specific ACP/session details still need validation during real integration and are isolated inside `packages/openclaw-adapter`.
- Prisma owns the schema and migrations, while the partial unique index is implemented via raw SQL migration.
- v1 does not physically delete core records by default and keeps retention policy as a later extension.
