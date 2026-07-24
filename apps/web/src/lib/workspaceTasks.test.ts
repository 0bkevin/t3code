import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceTaskId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { groupThreadsByWorkspaceTask, taskPresentationThread } from "./workspaceTasks";

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell & { environmentId: EnvironmentId }> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/tmp/task",
    latestTurn: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("workspace task grouping", () => {
  it("backfills legacy shells to one-task/one-tab groups", () => {
    const groups = groupThreadsByWorkspaceTask([makeThread("legacy")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("legacy");
  });

  it("orders sibling tabs and aggregates task status under the root title", () => {
    const taskId = WorkspaceTaskId.make("task-1");
    const groups = groupThreadsByWorkspaceTask([
      makeThread("child", {
        workspaceTaskId: taskId,
        title: "Alternative",
        tabPosition: 1,
        hasPendingApprovals: true,
        updatedAt: "2026-07-24T01:00:00.000Z",
      }),
      makeThread("root", {
        workspaceTaskId: taskId,
        title: "Task title",
        tabPosition: 0,
      }),
    ]);
    const group = groups[0]!;
    const presentation = taskPresentationThread(group, null);

    expect(group.tabs.map((thread) => thread.id)).toEqual(["root", "child"]);
    expect(presentation.title).toBe("Task title");
    expect(presentation.hasPendingApprovals).toBe(true);
    expect(presentation.updatedAt).toBe("2026-07-24T01:00:00.000Z");
  });
});
