import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

// Domain Types

export const WorktreeThreadStatus = Schema.Literals(["active", "settled", "archived", "deleted"]);
export type WorktreeThreadStatus = typeof WorktreeThreadStatus.Type;

export const WorktreeThreadRef = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  status: WorktreeThreadStatus,
});
export type WorktreeThreadRef = typeof WorktreeThreadRef.Type;

/**
 * Why a worktree is not safe to prune automatically. `status_unavailable`
 * covers detached HEADs and failed status probes — never assume safety when
 * the state cannot be read.
 */
export const WorktreePruneBlocker = Schema.Literals([
  "active_thread",
  "dirty",
  "unpushed",
  "status_unavailable",
]);
export type WorktreePruneBlocker = typeof WorktreePruneBlocker.Type;

export const WorktreeInfo = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.String,
  workspaceRoot: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  threads: Schema.Array(WorktreeThreadRef),
  /** No non-deleted thread references this worktree. */
  orphaned: Schema.Boolean,
  /** null when the working-tree status could not be read. */
  dirty: Schema.NullOr(Schema.Boolean),
  /** Number of changed/untracked files; null when status could not be read. */
  dirtyFileCount: Schema.NullOr(NonNegativeInt),
  hasUpstream: Schema.NullOr(Schema.Boolean),
  /**
   * Upstream is configured but its remote ref no longer exists (typically
   * deleted after the PR merged).
   */
  upstreamGone: Schema.Boolean,
  /** Commits on the branch that are not on its upstream. */
  aheadOfUpstreamCount: Schema.NullOr(NonNegativeInt),
  /** Commits on the upstream that are not on the branch. */
  behindUpstreamCount: Schema.NullOr(NonNegativeInt),
  /** Commits on the branch that are not on the default branch. */
  aheadOfDefaultCount: Schema.NullOr(NonNegativeInt),
  /** Latest linked-thread activity; falls back to directory mtime for orphans. */
  lastActivityAt: Schema.NullOr(IsoDateTime),
  safeToPrune: Schema.Boolean,
  pruneBlockers: Schema.Array(WorktreePruneBlocker),
});
export type WorktreeInfo = typeof WorktreeInfo.Type;

export const WorktreePruneSkipReason = Schema.Literals([
  "active_thread",
  "dirty",
  "unpushed",
  "status_unavailable",
  "unknown_worktree",
  "remove_failed",
]);
export type WorktreePruneSkipReason = typeof WorktreePruneSkipReason.Type;

// RPC Inputs

export const VcsListWorktreesInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type VcsListWorktreesInput = typeof VcsListWorktreesInput.Type;

export const VcsPruneWorktreesInput = Schema.Struct({
  paths: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});
export type VcsPruneWorktreesInput = typeof VcsPruneWorktreesInput.Type;

// RPC Results

export const VcsListWorktreesResult = Schema.Struct({
  worktrees: Schema.Array(WorktreeInfo),
});
export type VcsListWorktreesResult = typeof VcsListWorktreesResult.Type;

export const VcsPruneWorktreesResult = Schema.Struct({
  removed: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      workspaceRoot: TrimmedNonEmptyString,
    }),
  ),
  skipped: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      reason: WorktreePruneSkipReason,
      detail: Schema.optional(Schema.String),
    }),
  ),
});
export type VcsPruneWorktreesResult = typeof VcsPruneWorktreesResult.Type;
