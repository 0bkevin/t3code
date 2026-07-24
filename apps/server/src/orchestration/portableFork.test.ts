import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  WorkspaceTaskId,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { buildPortableForkProviderInput } from "./portableFork.ts";

function makeSource(messages: OrchestrationThread["messages"]): OrchestrationThread {
  return {
    id: ThreadId.make("source-thread"),
    projectId: ProjectId.make("project-1"),
    workspaceTaskId: WorkspaceTaskId.make("task-1"),
    tabLabel: "Main",
    tabPosition: 0,
    tabClosedAt: null,
    forkProvenance: null,
    title: "Investigate task tabs",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/task-tabs",
    worktreePath: "/tmp/task-tabs",
    latestTurn: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

describe("buildPortableForkProviderInput", () => {
  it("places the source transcript before the child tab request", () => {
    const result = buildPortableForkProviderInput({
      source: makeSource([
        {
          id: MessageId.make("message-1"),
          role: "user",
          text: "Inspect the architecture.",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
      ]),
      userInput: "Try a different implementation.",
    });

    expect(result).toContain("same T3 Code task");
    expect(result).toContain("Inspect the architecture.");
    expect(result).toContain("Shared worktree: /tmp/task-tabs");
    expect(result.endsWith("Try a different implementation.")).toBe(true);
  });

  it("bounds large transcripts while retaining recent messages", () => {
    const result = buildPortableForkProviderInput({
      source: makeSource([
        {
          id: MessageId.make("message-old"),
          role: "user",
          text: `old-${"x".repeat(48_000)}`,
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
        {
          id: MessageId.make("message-recent"),
          role: "assistant",
          text: "recent-context",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-07-24T00:01:00.000Z",
          updatedAt: "2026-07-24T00:01:00.000Z",
        },
      ]),
      userInput: "Continue.",
    });

    expect(result).not.toContain("old-");
    expect(result).toContain("recent-context");
    expect(result.length).toBeLessThan(50_000);
  });
});
