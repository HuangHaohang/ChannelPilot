# Linear 依赖关系待补清单 / Linear Dependency Backlog

## 中文说明

Linear project 和 issues 已创建，但在补 `blocking / blockedBy` 关系时 MCP 返回鉴权错误。以下依赖关系应在鉴权恢复后补到 Linear：

- `HAO-14 实现 task service`
  - blockedBy: `HAO-9`, `HAO-10`, `HAO-11`, `HAO-12`, `HAO-13`, `HAO-17`
- `HAO-15 实现 reconciler`
  - blockedBy: `HAO-9`, `HAO-10`, `HAO-11`, `HAO-13`, `HAO-14`, `HAO-17`
- `HAO-16 实现 notifier 与 outbox`
  - blockedBy: `HAO-9`, `HAO-10`, `HAO-11`, `HAO-13`, `HAO-14`
- `HAO-18 实现 REST API`
  - blockedBy: `HAO-9`, `HAO-10`, `HAO-11`, `HAO-12`, `HAO-13`, `HAO-14`, `HAO-17`
- `HAO-19 实现本地 mock worker`
  - blockedBy: `HAO-17`, `HAO-18`
- `HAO-20 实现 docker-compose 与部署骨架`
  - blockedBy: `HAO-9`, `HAO-18`, `HAO-17`, `HAO-22`
- `HAO-21 补齐测试与 QA`
  - blockedBy: `HAO-9`, `HAO-10`, `HAO-11`, `HAO-12`, `HAO-13`, `HAO-14`, `HAO-15`, `HAO-16`, `HAO-17`, `HAO-18`, `HAO-19`
- `HAO-22 补齐 README 与双语架构文档`
  - blockedBy: `HAO-9`, `HAO-10`, `HAO-11`, `HAO-13`, `HAO-14`, `HAO-15`, `HAO-16`, `HAO-17`, `HAO-18`

## English Summary

The Linear project and issues were created successfully, but MCP returned an auth error when updating `blocking / blockedBy` relations. The dependency list above should be applied in Linear once auth is restored.
