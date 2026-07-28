/**
 * WorktreeService - Managed worktree inventory and safe pruning.
 *
 * Derives per-project worktree records by joining `git worktree list` output
 * against projected thread rows, classifies each worktree's prune safety from
 * purely local git state (no forge API calls), and removes safe worktrees.
 *
 * Worktree removal never deletes branches or checkpoint refs, so pruning a
 * safe worktree is lossless: the thread keeps its `branch`/`worktreePath`
 * metadata and the worktree can be recreated from the branch later.
 *
 * @module WorktreeService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  GitManagerError,
  type GitManagerServiceError,
  type ProjectId,
  type VcsListWorktreesInput,
  type VcsListWorktreesResult,
  type VcsPruneWorktreesInput,
  type VcsPruneWorktreesResult,
  type WorktreeInfo,
  type WorktreePruneBlocker,
  type WorktreePruneSkipReason,
  type WorktreeThreadRef,
  type WorktreeThreadStatus,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import {
  type ProjectionThread,
  ProjectionThreadRepository,
} from "../persistence/Services/ProjectionThreads.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const WORKTREE_STATUS_CONCURRENCY = 8;
const PROJECT_SCAN_CONCURRENCY = 4;

export class WorktreeService extends Context.Service<
  WorktreeService,
  {
    /** Inventory of managed worktrees across all (or one) projects. */
    readonly listWorktrees: (
      input: VcsListWorktreesInput,
    ) => Effect.Effect<VcsListWorktreesResult, GitManagerServiceError>;

    /**
     * Remove the requested worktrees after re-validating each one is still
     * safe to prune. Never forces: git itself refuses dirty removals as a
     * last line of defense. Finishes with `git worktree prune` on every
     * touched repository.
     */
    readonly pruneWorktrees: (
      input: VcsPruneWorktreesInput,
    ) => Effect.Effect<VcsPruneWorktreesResult, GitManagerServiceError>;

    /**
     * Recreate a previously pruned worktree from its still-existing branch.
     * No-op when the directory already exists. Fails with a clear error when
     * the branch is gone (e.g. deleted manually).
     */
    readonly reviveWorktree: (input: {
      readonly workspaceRoot: string;
      readonly worktreePath: string;
      readonly branch: string;
    }) => Effect.Effect<{ readonly revived: boolean }, GitManagerServiceError>;
  }
>()("t3/vcs/WorktreeService") {}

interface ParsedWorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
}

function parseWorktreeListPorcelain(stdout: string): ParsedWorktreeEntry[] {
  const entries: ParsedWorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  const flush = () => {
    if (currentPath !== null) {
      entries.push({ path: currentPath, branch: currentBranch });
    }
    currentPath = null;
    currentBranch = null;
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length);
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return entries;
}

interface BranchSyncInfo {
  readonly upstream: string | null;
  /** Upstream configured but its remote ref no longer exists (deleted after merge). */
  readonly upstreamGone: boolean;
  readonly aheadOfUpstreamCount: number | null;
  readonly behindUpstreamCount: number | null;
}

function parseBranchSyncInfo(stdout: string): Map<string, BranchSyncInfo> {
  const result = new Map<string, BranchSyncInfo>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [name, upstream = "", track = ""] = line.split("\t");
    if (!name) continue;
    if (upstream.length === 0) {
      result.set(name, {
        upstream: null,
        upstreamGone: false,
        aheadOfUpstreamCount: null,
        behindUpstreamCount: null,
      });
      continue;
    }
    if (track === "gone") {
      result.set(name, {
        upstream,
        upstreamGone: true,
        aheadOfUpstreamCount: null,
        behindUpstreamCount: null,
      });
      continue;
    }
    const aheadMatch = /(?:^|, )ahead (\d+)/.exec(track);
    const behindMatch = /(?:^|, )behind (\d+)/.exec(track);
    result.set(name, {
      upstream,
      upstreamGone: false,
      aheadOfUpstreamCount: aheadMatch ? Number(aheadMatch[1]) : 0,
      behindUpstreamCount: behindMatch ? Number(behindMatch[1]) : 0,
    });
  }
  return result;
}

function threadStatus(thread: ProjectionThread): WorktreeThreadStatus {
  if (thread.deletedAt !== null) return "deleted";
  if (thread.archivedAt !== null) return "archived";
  if (thread.settledOverride === "settled") return "settled";
  return "active";
}

function latestIsoTimestamp(values: ReadonlyArray<string>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latest = value;
    }
  }
  return latest;
}

export const make = Effect.gen(function* () {
  const { worktreesDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = yield* GitWorkflowService;
  const projectRepository = yield* ProjectionProjectRepository;
  const threadRepository = yield* ProjectionThreadRepository;

  // Canonicalize through symlinks (macOS /var → /private/var) so paths from
  // `git worktree list` compare equal to configured and stored paths.
  const canonicalizePath = (value: string) =>
    fs.realPath(value).pipe(Effect.orElseSucceed(() => pathService.resolve(value)));

  const managedWorktreesRoot = yield* canonicalizePath(worktreesDir);

  const isManagedWorktreePath = (worktreePath: string): boolean => {
    const relative = pathService.relative(managedWorktreesRoot, worktreePath);
    return relative.length > 0 && !relative.startsWith("..") && !pathService.isAbsolute(relative);
  };

  const toGitManagerError = (operation: string, cwd: string, detail: string) => (cause: unknown) =>
    new GitManagerError({ operation, cwd, detail, cause });

  const executeGitLenient = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd, args, allowNonZeroExit: true, timeoutMs: 15_000 })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout : null)));

  const resolveDefaultRef = Effect.fn("WorktreeService.resolveDefaultRef")(function* (cwd: string) {
    const originHead = yield* executeGitLenient("WorktreeService.resolveDefaultRef", cwd, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
    if (originHead !== null && originHead.trim().length > 0) {
      return originHead.trim();
    }
    for (const candidate of ["refs/heads/main", "refs/heads/master"]) {
      const exists = yield* git
        .execute({
          operation: "WorktreeService.resolveDefaultRef.localFallback",
          cwd,
          args: ["show-ref", "--verify", "--quiet", candidate],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(Effect.map((result) => result.exitCode === 0));
      if (exists) {
        return candidate;
      }
    }
    return null;
  });

  const countAheadOfDefault = Effect.fn("WorktreeService.countAheadOfDefault")(function* (
    cwd: string,
    branch: string,
    defaultRef: string,
  ) {
    const stdout = yield* executeGitLenient("WorktreeService.countAheadOfDefault", cwd, [
      "rev-list",
      "--count",
      `refs/heads/${branch}`,
      "--not",
      defaultRef,
    ]);
    if (stdout === null) return null;
    const count = Number(stdout.trim());
    return Number.isNaN(count) ? null : count;
  });

  const worktreeDirMtime = (worktreePath: string) =>
    fs.stat(worktreePath).pipe(
      Effect.map((info) =>
        Option.match(info.mtime, {
          onNone: () => null,
          onSome: (mtime) => mtime.toISOString(),
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  const listProjectWorktrees = Effect.fn("WorktreeService.listProjectWorktrees")(
    function* (project: {
      readonly projectId: ProjectId;
      readonly title: string;
      readonly workspaceRoot: string;
    }) {
      const worktreeListStdout = yield* executeGitLenient(
        "WorktreeService.listProjectWorktrees.worktreeList",
        project.workspaceRoot,
        ["worktree", "list", "--porcelain"],
      ).pipe(
        // A missing or non-git workspace root contributes no worktrees rather
        // than failing the whole inventory.
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (worktreeListStdout === null) {
        return [] as WorktreeInfo[];
      }

      const rawEntries = parseWorktreeListPorcelain(worktreeListStdout);
      const entries = (yield* Effect.forEach(rawEntries, (entry) =>
        canonicalizePath(entry.path).pipe(
          Effect.map((canonical) => ({ ...entry, path: canonical })),
        ),
      )).filter((entry) => isManagedWorktreePath(entry.path));
      if (entries.length === 0) {
        return [] as WorktreeInfo[];
      }

      const [threads, branchSyncStdout, defaultRef] = yield* Effect.all(
        [
          threadRepository
            .listByProjectId({ projectId: project.projectId })
            .pipe(
              Effect.mapError(
                toGitManagerError(
                  "WorktreeService.listProjectWorktrees.threads",
                  project.workspaceRoot,
                  "Failed to load projected threads for the worktree inventory.",
                ),
              ),
            ),
          executeGitLenient(
            "WorktreeService.listProjectWorktrees.branchSync",
            project.workspaceRoot,
            [
              "for-each-ref",
              "refs/heads",
              "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)",
            ],
          ),
          resolveDefaultRef(project.workspaceRoot),
        ],
        { concurrency: "unbounded" },
      );

      const branchSync = parseBranchSyncInfo(branchSyncStdout ?? "");
      const threadsByWorktreePath = new Map<string, ProjectionThread[]>();
      for (const thread of threads) {
        if (thread.worktreePath === null) continue;
        const resolved = yield* canonicalizePath(thread.worktreePath);
        const bucket = threadsByWorktreePath.get(resolved);
        if (bucket) {
          bucket.push(thread);
        } else {
          threadsByWorktreePath.set(resolved, [thread]);
        }
      }

      return yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const resolvedPath = entry.path;
            const branchName = entry.branch;
            const linkedThreads = threadsByWorktreePath.get(resolvedPath) ?? [];
            const threadRefs: WorktreeThreadRef[] = linkedThreads.map((thread) => ({
              threadId: thread.threadId,
              title: thread.title,
              status: threadStatus(thread),
            }));
            const orphaned = threadRefs.every((thread) => thread.status === "deleted");

            const workingTree = yield* gitWorkflow.localStatus({ cwd: entry.path }).pipe(
              Effect.map((status) => ({
                dirty: status.hasWorkingTreeChanges as boolean | null,
                dirtyFileCount: status.workingTree.files.length as number | null,
              })),
              Effect.catchCause(() => Effect.succeed({ dirty: null, dirtyFileCount: null })),
            );
            const dirty = workingTree.dirty;

            const sync = branchName === null ? undefined : branchSync.get(branchName);
            const hasUpstream = sync === undefined ? null : sync.upstream !== null;
            const upstreamGone = sync?.upstreamGone ?? false;
            const aheadOfUpstreamCount = sync?.aheadOfUpstreamCount ?? null;
            const behindUpstreamCount = sync?.behindUpstreamCount ?? null;
            // Only spend a rev-list on branches that cannot prove safety via
            // their upstream tracking state.
            const needsDefaultComparison =
              sync === undefined || sync.upstream === null || sync.upstreamGone;
            const aheadOfDefaultCount =
              branchName !== null && defaultRef !== null && needsDefaultComparison
                ? yield* countAheadOfDefault(project.workspaceRoot, branchName, defaultRef)
                : null;

            const nonDeletedActivity = latestIsoTimestamp(
              linkedThreads.filter((thread) => thread.deletedAt === null).map((t) => t.updatedAt),
            );
            const anyThreadActivity =
              nonDeletedActivity ?? latestIsoTimestamp(linkedThreads.map((t) => t.updatedAt));
            const lastActivityAt = anyThreadActivity ?? (yield* worktreeDirMtime(entry.path));

            const blockers: WorktreePruneBlocker[] = [];
            if (threadRefs.some((thread) => thread.status === "active")) {
              blockers.push("active_thread");
            }
            if (dirty === true) {
              blockers.push("dirty");
            } else if (dirty === null) {
              blockers.push("status_unavailable");
            }
            if (branchName === null) {
              // Detached HEAD: no branch retains this worktree's commits.
              blockers.push("status_unavailable");
            } else if (sync !== undefined && sync.upstream !== null && !sync.upstreamGone) {
              if (aheadOfUpstreamCount === null) {
                blockers.push("status_unavailable");
              } else if (aheadOfUpstreamCount > 0) {
                blockers.push("unpushed");
              }
            } else if (sync !== undefined && sync.upstreamGone) {
              // The branch was pushed and its remote ref was deleted — the usual
              // post-merge state. The local branch keeps the commits, so this is
              // not "unpushed".
            } else if (aheadOfDefaultCount === null) {
              blockers.push("status_unavailable");
            } else if (aheadOfDefaultCount > 0) {
              blockers.push("unpushed");
            }

            return {
              projectId: project.projectId,
              projectTitle: project.title,
              workspaceRoot: project.workspaceRoot,
              path: resolvedPath,
              branch: branchName,
              threads: threadRefs,
              orphaned,
              dirty,
              dirtyFileCount: workingTree.dirtyFileCount,
              hasUpstream,
              upstreamGone,
              aheadOfUpstreamCount,
              behindUpstreamCount,
              aheadOfDefaultCount,
              lastActivityAt,
              safeToPrune: blockers.length === 0,
              pruneBlockers: blockers,
            } satisfies WorktreeInfo;
          }),
        { concurrency: WORKTREE_STATUS_CONCURRENCY },
      );
    },
  );

  const listWorktrees: WorktreeService["Service"]["listWorktrees"] = Effect.fn(
    "WorktreeService.listWorktrees",
  )(function* (input) {
    const projects = yield* projectRepository
      .listAll()
      .pipe(
        Effect.mapError(
          toGitManagerError(
            "WorktreeService.listWorktrees.projects",
            managedWorktreesRoot,
            "Failed to load projects for the worktree inventory.",
          ),
        ),
      );
    const selectedProjects = projects.filter(
      (project) =>
        project.deletedAt === null &&
        (input.projectId === undefined || project.projectId === input.projectId),
    );

    const perProject = yield* Effect.forEach(
      selectedProjects,
      (project) => listProjectWorktrees(project),
      { concurrency: PROJECT_SCAN_CONCURRENCY },
    );

    // Two projects can point at the same repository; keep the first record
    // per worktree path.
    const seen = new Set<string>();
    const worktrees: WorktreeInfo[] = [];
    for (const record of perProject.flat()) {
      if (seen.has(record.path)) continue;
      seen.add(record.path);
      worktrees.push(record);
    }
    worktrees.sort((a, b) => {
      const aMs = a.lastActivityAt === null ? 0 : Date.parse(a.lastActivityAt);
      const bMs = b.lastActivityAt === null ? 0 : Date.parse(b.lastActivityAt);
      return aMs - bMs;
    });
    return { worktrees };
  });

  const pruneWorktrees: WorktreeService["Service"]["pruneWorktrees"] = Effect.fn(
    "WorktreeService.pruneWorktrees",
  )(function* (input) {
    // Re-derive the inventory so safety reflects the current state, never a
    // stale client view.
    const { worktrees } = yield* listWorktrees({});
    const byPath = new Map(worktrees.map((worktree) => [worktree.path, worktree]));

    const removed: Array<{ path: string; workspaceRoot: string }> = [];
    const skipped: Array<{ path: string; reason: WorktreePruneSkipReason; detail?: string }> = [];
    const touchedRoots = new Set<string>();

    for (const requestedPath of input.paths) {
      const worktree = byPath.get(yield* canonicalizePath(requestedPath));
      if (worktree === undefined) {
        skipped.push({ path: requestedPath, reason: "unknown_worktree" });
        continue;
      }
      if (!worktree.safeToPrune) {
        skipped.push({
          path: worktree.path,
          reason: worktree.pruneBlockers[0] ?? "status_unavailable",
        });
        continue;
      }
      const removalError = yield* gitWorkflow
        .removeWorktree({ cwd: worktree.workspaceRoot, path: worktree.path })
        .pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(error)),
        );
      if (removalError !== null) {
        skipped.push({
          path: worktree.path,
          reason: "remove_failed",
          detail: removalError.message,
        });
        continue;
      }
      removed.push({ path: worktree.path, workspaceRoot: worktree.workspaceRoot });
      touchedRoots.add(worktree.workspaceRoot);
    }

    yield* Effect.forEach(
      [...touchedRoots],
      (workspaceRoot) =>
        executeGitLenient("WorktreeService.pruneWorktrees.gitPrune", workspaceRoot, [
          "worktree",
          "prune",
        ]).pipe(Effect.ignore({ log: true })),
      { concurrency: 1 },
    );

    if (removed.length > 0) {
      yield* Effect.logInfo("worktrees.pruned", {
        removedCount: removed.length,
        skippedCount: skipped.length,
        removedPaths: removed.map((entry) => entry.path),
      });
    }

    return { removed, skipped };
  });

  const reviveWorktree: WorktreeService["Service"]["reviveWorktree"] = Effect.fn(
    "WorktreeService.reviveWorktree",
  )(function* (input) {
    const exists = yield* fs.exists(input.worktreePath).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return { revived: false };
    }

    const branchExists = yield* git
      .execute({
        operation: "WorktreeService.reviveWorktree.branchExists",
        cwd: input.workspaceRoot,
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(Effect.map((result) => result.exitCode === 0));
    if (!branchExists) {
      return yield* new GitManagerError({
        operation: "WorktreeService.reviveWorktree",
        cwd: input.workspaceRoot,
        detail: `Cannot recreate the worktree at ${input.worktreePath}: branch '${input.branch}' no longer exists.`,
      });
    }

    // A manually deleted worktree directory leaves a stale registration that
    // blocks `git worktree add` at the same path.
    yield* executeGitLenient("WorktreeService.reviveWorktree.prune", input.workspaceRoot, [
      "worktree",
      "prune",
    ]);
    yield* gitWorkflow.createWorktree({
      cwd: input.workspaceRoot,
      refName: input.branch,
      path: input.worktreePath,
    });
    yield* Effect.logInfo("worktree.revived", {
      worktreePath: input.worktreePath,
      branch: input.branch,
    });
    return { revived: true };
  });

  return WorktreeService.of({ listWorktrees, pruneWorktrees, reviveWorktree });
});

export const layer = Layer.effect(WorktreeService, make);
