import type { PublicTaskState, TaskState } from "@channelpilot/shared-types";

export function toPublicTaskState(state: TaskState): PublicTaskState {
  if (state === "cancelling") {
    return "running";
  }

  return state;
}

export function toPublicStateLabel(state: TaskState): string {
  switch (state) {
    case "queued":
      return "已受理";
    case "starting":
      return "准备启动";
    case "binding":
      return "正在绑定";
    case "running":
      return "执行中";
    case "waiting_input":
      return "等待输入";
    case "blocked":
      return "已阻塞";
    case "cancelling":
      return "正在取消";
    case "summarizing":
      return "整理总结中";
    case "completed":
      return "已完成";
    case "failed":
      return "已失败";
    case "cancelled":
      return "已取消";
    case "lost":
      return "状态丢失";
  }
}

export function canSteerPublicState(state: TaskState): boolean {
  return ["starting", "binding", "running", "waiting_input", "blocked", "cancelling", "lost"].includes(state);
}

export function canStopPublicState(state: TaskState): boolean {
  return ["queued", "starting", "binding", "running", "waiting_input", "blocked", "cancelling", "summarizing", "lost"].includes(state);
}

export function canResumePublicState(state: TaskState): boolean {
  return ["waiting_input", "blocked", "lost"].includes(state);
}
