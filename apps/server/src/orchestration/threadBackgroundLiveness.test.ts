import { describe, expect, it } from "vite-plus/test";
import {
  clearThreadLiveness,
  getThreadBackgroundLiveness,
  recordTaskLiveness,
} from "./threadBackgroundLiveness.ts";

describe("threadBackgroundLiveness", () => {
  it("agents present as working; monitors as monitoring; agents win", () => {
    const threadId = "t-live-1";
    recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
    });
    expect(getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: undefined,
      kind: "started",
    });
    expect(getThreadBackgroundLiveness(threadId)).toBe("working");
    recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: "completed",
      kind: "completed",
    });
    expect(getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: "completed",
      kind: "completed",
    });
    expect(getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("untyped rows (workflow members, Codex children) count as agents", () => {
    const threadId = "t-live-2";
    recordTaskLiveness({
      threadId,
      taskId: "wf:1",
      taskType: undefined,
      status: "running",
      kind: "progress",
    });
    expect(getThreadBackgroundLiveness(threadId)).toBe("working");
    recordTaskLiveness({
      threadId,
      taskId: "wf:1",
      taskType: undefined,
      status: "interrupted",
      kind: "updated",
    });
    expect(getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("plan tasks are inert; session exit clears everything", () => {
    const threadId = "t-live-3";
    recordTaskLiveness({
      threadId,
      taskId: "p1",
      taskType: "plan",
      status: undefined,
      kind: "started",
    });
    expect(getThreadBackgroundLiveness(threadId)).toBeNull();
    recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "local_workflow",
      status: undefined,
      kind: "started",
    });
    expect(getThreadBackgroundLiveness(threadId)).toBe("working");
    clearThreadLiveness(threadId);
    expect(getThreadBackgroundLiveness(threadId)).toBeNull();
  });
});
