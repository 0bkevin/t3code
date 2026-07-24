import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceTaskId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-07-24T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const taskId = WorkspaceTaskId.make("task-1");
const rootThreadId = ThreadId.make("thread-root");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
} as const;

const seededReadModel = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("event-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("command-project"),
    causationEventId: null,
    correlationId: CommandId.make("command-project"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-root"),
    aggregateKind: "thread",
    aggregateId: rootThreadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("command-root"),
    causationEventId: null,
    correlationId: CommandId.make("command-root"),
    metadata: {},
    payload: {
      threadId: rootThreadId,
      projectId,
      workspaceTaskId: taskId,
      tabLabel: null,
      tabPosition: 0,
      tabClosedAt: null,
      forkProvenance: null,
      title: "Task",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/task",
      worktreePath: "/tmp/project-task",
      createdAt: now,
      updatedAt: now,
    },
  });
});

const seededReadModelWithSibling = Effect.gen(function* () {
  const readModel = yield* seededReadModel;
  const decided = yield* decideOrchestrationCommand({
    readModel,
    command: {
      type: "thread.create",
      commandId: CommandId.make("command-seed-child"),
      threadId: ThreadId.make("thread-child"),
      projectId,
      workspaceTaskId: taskId,
      tabPosition: 1,
      title: "Alternative",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/task",
      worktreePath: "/tmp/project-task",
      createdAt: now,
    },
  });
  const event = Array.isArray(decided) ? decided[0]! : decided;
  return yield* projectEvent(readModel, event);
});

it.layer(NodeServices.layer)("task tab invariants", (it) => {
  it.effect("accepts a sibling tab on the same project and worktree", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        readModel: yield* seededReadModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("command-child"),
          threadId: ThreadId.make("thread-child"),
          projectId,
          workspaceTaskId: taskId,
          tabPosition: 1,
          forkProvenance: {
            mode: "portable",
            sourceThreadId: rootThreadId,
            createdAt: now,
          },
          title: "Alternative",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/task",
          worktreePath: "/tmp/project-task",
          createdAt: now,
        },
      });
      const firstEvent = Array.isArray(event) ? event[0] : event;
      expect(firstEvent.type).toBe("thread.created");
      expect(firstEvent.payload).toMatchObject({
        workspaceTaskId: taskId,
        tabPosition: 1,
      });
    }),
  );

  it.effect("rejects a sibling tab that points at another worktree", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: yield* seededReadModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("command-wrong-tree"),
            threadId: ThreadId.make("thread-wrong-tree"),
            projectId,
            workspaceTaskId: taskId,
            title: "Wrong tree",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "other",
            worktreePath: "/tmp/other-tree",
            createdAt: now,
          },
        }),
      );
      expect(failure.message).toContain("must keep project and worktree identity");
    }),
  );

  it.effect("rejects moving one tab to another worktree after task creation", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: yield* seededReadModelWithSibling,
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("command-move-root"),
            threadId: rootThreadId,
            worktreePath: "/tmp/other-tree",
          },
        }),
      );
      expect(failure.message).toContain("must keep project and worktree identity");
    }),
  );

  it.effect("rejects a deleted source for a portable fork", () =>
    Effect.gen(function* () {
      const readModel = yield* seededReadModel;
      const withDeletedSource = {
        ...readModel,
        threads: readModel.threads.map((thread) =>
          thread.id === rootThreadId ? { ...thread, deletedAt: now } : thread,
        ),
      };
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: withDeletedSource,
          command: {
            type: "thread.create",
            commandId: CommandId.make("command-deleted-source"),
            threadId: ThreadId.make("thread-from-deleted-source"),
            projectId,
            workspaceTaskId: taskId,
            tabPosition: 1,
            forkProvenance: {
              mode: "portable",
              sourceThreadId: rootThreadId,
              createdAt: now,
            },
            title: "Deleted source",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature/task",
            worktreePath: "/tmp/project-task",
            createdAt: now,
          },
        }),
      );
      expect(failure.message).toContain("portable fork source must be an existing tab");
    }),
  );
});
