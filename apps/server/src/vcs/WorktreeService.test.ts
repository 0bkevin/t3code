import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { assert, it } from "@effect/vitest";

import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import {
  type ProjectionProject,
  ProjectionProjectRepository,
} from "../persistence/Services/ProjectionProjects.ts";
import {
  type ProjectionThread,
  ProjectionThreadRepository,
} from "../persistence/Services/ProjectionThreads.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { layer as worktreeServiceLayer, WorktreeService } from "./WorktreeService.ts";

const PROJECT_ID = ProjectId.make("project-worktrees-test");

let projectRows: ProjectionProject[] = [];
let threadRows: ProjectionThread[] = [];

const projectRepositoryMock = Layer.mock(ProjectionProjectRepository, {
  listAll: () => Effect.succeed(projectRows),
});

const threadRepositoryMock = Layer.mock(ProjectionThreadRepository, {
  listByProjectId: ({ projectId }) =>
    Effect.succeed(threadRows.filter((thread) => thread.projectId === projectId)),
});

// WorktreeService only touches localStatus/createWorktree/removeWorktree on
// the workflow service; back those with the real git driver so the test
// exercises real git behavior without GitManager's heavy dependency set.
const gitWorkflowMock = Layer.effect(
  GitWorkflowService,
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const localStatus = (input: { readonly cwd: string }) =>
      driver
        .execute({
          operation: "WorktreeServiceTest.localStatus",
          cwd: input.cwd,
          args: ["status", "--porcelain"],
          timeoutMs: 10_000,
        })
        .pipe(
          Effect.map(
            (result): VcsStatusLocalResult => ({
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: false,
              refName: null,
              hasWorkingTreeChanges: result.stdout.trim().length > 0,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          ),
        );
    const mocked = Layer.mock(GitWorkflowService, {
      localStatus,
      createWorktree: driver.createWorktree,
      removeWorktree: driver.removeWorktree,
    });
    return yield* Effect.provide(Effect.service(GitWorkflowService), mocked);
  }),
);

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-worktree-service-test-",
});

const TestLayer = worktreeServiceLayer.pipe(
  Layer.provide(gitWorkflowMock),
  Layer.provide(projectRepositoryMock),
  Layer.provide(threadRepositoryMock),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "WorktreeServiceTest.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

function makeThread(
  overrides: Partial<ProjectionThread> & Pick<ProjectionThread, "threadId">,
): ProjectionThread {
  return {
    projectId: PROJECT_ID,
    title: "Test thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurnId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    latestUserMessageAt: null,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt: null,
    ...overrides,
  };
}

const setupRepoWithWorktrees = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;

  const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-worktree-repo-",
  });
  yield* runGit(workspaceRoot, ["init", "-b", "main"]);
  yield* runGit(workspaceRoot, ["config", "user.email", "test@test.com"]);
  yield* runGit(workspaceRoot, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(path.join(workspaceRoot, "README.md"), "hello\n");
  yield* runGit(workspaceRoot, ["add", "README.md"]);
  yield* runGit(workspaceRoot, ["commit", "-m", "initial"]);

  const activeWorktree = yield* driver.createWorktree({
    cwd: workspaceRoot,
    refName: "main",
    newRefName: "t3code/aaaa1111",
    path: null,
  });
  const settledWorktree = yield* driver.createWorktree({
    cwd: workspaceRoot,
    refName: "main",
    newRefName: "t3code/bbbb2222",
    path: null,
  });

  projectRows = [
    {
      projectId: PROJECT_ID,
      title: "Worktrees Test",
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      deletedAt: null,
    },
  ];
  threadRows = [
    makeThread({
      threadId: ThreadId.make("thread-active"),
      branch: "t3code/aaaa1111",
      worktreePath: activeWorktree.worktree.path,
      updatedAt: "2026-07-20T00:00:00.000Z",
    }),
    makeThread({
      threadId: ThreadId.make("thread-settled"),
      branch: "t3code/bbbb2222",
      worktreePath: settledWorktree.worktree.path,
      settledOverride: "settled",
      settledAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }),
  ];

  return {
    workspaceRoot,
    activeWorktreePath: activeWorktree.worktree.path,
    settledWorktreePath: settledWorktree.worktree.path,
  };
});

it.layer(TestLayer)("WorktreeService", (it) => {
  it.effect("classifies, prunes safely, and revives worktrees", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* WorktreeService;
      const repo = yield* setupRepoWithWorktrees;

      // Inventory: the active thread blocks its worktree, the settled one is
      // safe (clean, no upstream, no commits beyond the default branch).
      const inventory = yield* service.listWorktrees({});
      assert.equal(inventory.worktrees.length, 2);
      const activeRecord = inventory.worktrees.find(
        (worktree) => worktree.branch === "t3code/aaaa1111",
      );
      const settledRecord = inventory.worktrees.find(
        (worktree) => worktree.branch === "t3code/bbbb2222",
      );
      assert.isDefined(activeRecord);
      assert.isDefined(settledRecord);
      assert.isFalse(activeRecord?.safeToPrune);
      assert.deepEqual(activeRecord?.pruneBlockers, ["active_thread"]);
      assert.isFalse(activeRecord?.orphaned);
      assert.isTrue(settledRecord?.safeToPrune);
      assert.equal(settledRecord?.dirty, false);
      assert.equal(settledRecord?.threads[0]?.status, "settled");
      assert.equal(settledRecord?.lastActivityAt, "2026-07-10T00:00:00.000Z");

      // A dirty settled worktree loses its safety and reports the blocker.
      yield* fileSystem.writeFileString(
        path.join(repo.settledWorktreePath, "scratch.txt"),
        "uncommitted\n",
      );
      const dirtyInventory = yield* service.listWorktrees({});
      const dirtyRecord = dirtyInventory.worktrees.find(
        (worktree) => worktree.branch === "t3code/bbbb2222",
      );
      assert.isFalse(dirtyRecord?.safeToPrune);
      assert.deepEqual(dirtyRecord?.pruneBlockers, ["dirty"]);
      yield* fileSystem.remove(path.join(repo.settledWorktreePath, "scratch.txt"));

      // Prune re-validates: the active-thread worktree is skipped, the safe
      // one is removed from disk, and the branch survives.
      const canonicalSettledPath = yield* fileSystem.realPath(repo.settledWorktreePath);
      const pruneResult = yield* service.pruneWorktrees({
        paths: [repo.activeWorktreePath, repo.settledWorktreePath],
      });
      assert.equal(pruneResult.removed.length, 1);
      assert.equal(pruneResult.removed[0]?.path, canonicalSettledPath);
      assert.equal(pruneResult.skipped.length, 1);
      assert.equal(pruneResult.skipped[0]?.reason, "active_thread");
      assert.isFalse(yield* fileSystem.exists(repo.settledWorktreePath));
      const branchList = yield* Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        return yield* driver.execute({
          operation: "WorktreeServiceTest.branchList",
          cwd: repo.workspaceRoot,
          args: ["branch", "--list", "t3code/bbbb2222"],
          timeoutMs: 10_000,
        });
      });
      assert.include(branchList.stdout, "t3code/bbbb2222");

      // Revival recreates the pruned worktree from the surviving branch.
      const revived = yield* service.reviveWorktree({
        workspaceRoot: repo.workspaceRoot,
        worktreePath: repo.settledWorktreePath,
        branch: "t3code/bbbb2222",
      });
      assert.isTrue(revived.revived);
      assert.isTrue(yield* fileSystem.exists(repo.settledWorktreePath));
      const revivedAgain = yield* service.reviveWorktree({
        workspaceRoot: repo.workspaceRoot,
        worktreePath: repo.settledWorktreePath,
        branch: "t3code/bbbb2222",
      });
      assert.isFalse(revivedAgain.revived);
    }),
  );
});
