# Worktree Management v1

## Problem

t3code creates a worktree per thread (`~/.t3/worktrees/<project>/t3code-<hash>`, branch
`t3code/<8hex>`) but has almost no lifecycle management. With the settled system, threads
are rarely deleted anymore, so worktrees accumulate unboundedly (real case: 186 worktrees).

Current state:

- No worktree registry. A worktree exists only as the denormalized `worktree_path` column on
  `projection_threads` (`apps/server/src/persistence/Layers/ProjectionThreads.ts:41`). Nothing
  records creation time, last use, or dirty state.
- The only cleanup path is the interactive "delete worktree too?" dialog when deleting the
  last thread that uses one (`apps/web/src/hooks/useThreadActions.ts:253-397`). It is
  desktop-only (requires `localApi`), so web users always leak worktrees. `thread.delete`
  on the server never touches the worktree (`apps/server/src/orchestration/decider.ts:381-401`).
- `git worktree prune` is never invoked anywhere.
- Settling (`settled_override`/`settled_at`) is a projection-level soft-hide; it has no effect
  on the worktree, so settled threads pin their worktrees forever.
- Checkpoint refs (`refs/t3/checkpoints/...`) live in the shared ref store, not in the
  worktree's private git dir, so removing a worktree does not lose checkpoints. Branches are
  likewise repo-level. This is what makes lossless revival possible.

## Decisions (locked)

1. **Worktrees only in v1.** No branch deletion, no checkpoint-ref GC. Branches are cheap and
   keeping them makes revival trivial. Merged-branch cleanup can be a later tier.
2. **No safety-snapshot-before-delete.** Auto-prune only ever touches *safe* worktrees. Users
   may force-delete a dirty worktree, but the UI must make clear that this is destructive and
   the uncommitted state cannot be restored later — that's on them.
3. **Never auto-prune dirty worktrees.** Instead, surface them in the Worktrees settings page
   as "needs attention": e.g. *"This worktree has had no activity for N days, but has
   uncommitted changes so it won't be deleted automatically."*
4. **Global policy settings only.** Per-project overrides are an application-wide capability
   we don't have yet; out of scope.
5. **Orphan handling is configurable.** A setting chooses whether orphaned worktrees (no
   thread references them) are deleted immediately when they become orphaned, or just fall
   under the normal inactivity schedule.
6. **CLI is a stretch goal and must be super minimal** (`t3 worktrees list` / `prune`), or
   dropped from v1 entirely.

## Definitions

**Worktree record** (derived, not persisted): for each entry in `git worktree list --porcelain`
under the project's worktrees dir, joined against thread rows sharing that normalized path:

- `path`, `branch`
- linked threads: id, title, effective settled state, deleted state
- `dirty` (working-tree changes, via existing `localStatus` — `GitManager.ts:856-864`)
- `unpushed` (`aheadCount` / `aheadOfDefaultCount` / `hasUpstream` via `remoteStatus`)
- `prState` (merged / open / none, already available on the remote status result)
- `lastActivity`: max of linked threads' last activity / `settled_at`; fallback to worktree
  dir mtime for orphans
- `orphaned`: no non-deleted thread references the path
- `safeToPrune`: see below

**Safe to prune** = ALL of:

- no *active* (unsettled, undeleted) thread references the worktree
- working tree clean
- branch merged, or fully pushed (`hasUpstream && aheadCount == 0`), or contains no commits
  beyond its recorded merge-base (`aheadOfDefaultCount == 0`)
- path is inside the managed worktrees dir and is not the project `workspaceRoot`

**Auto-prunable** = safeToPrune AND (orphaned with "delete orphans immediately" enabled, OR
`lastActivity` older than the configured inactivity window).

## Components

### 1. Worktree inventory service (server)

New Effect service (e.g. `apps/server/src/vcs/WorktreeInventory.ts`) that produces the derived
records above per project. Scan via `git worktree list --porcelain` (driver already parses
this at `GitVcsDriverCore.ts:2121-2164` for branch annotation — extract/reuse). Status via
existing `GitManager.localStatus`/`remoteStatus` (already ~1s cached). Short TTL cache on the
assembled inventory; a full status sweep across 186 worktrees is not free, so statuses should
be fetched lazily/batched and the settings page should render the list first and stream
status in.

Exposed over WS RPC alongside the existing `vcsCreateWorktree`/`vcsRemoveWorktree`
(`apps/server/src/ws.ts:1838-1849`): `vcsListWorktrees` (inventory) and
`vcsPruneWorktrees` (bulk delete of a provided safe set, server re-validates safety before
each removal — never trust the client's classification).

### 2. Worktrees settings page (web)

Follow the appearance-settings pattern:

- route `apps/web/src/routes/settings.worktrees.tsx`
- `WorktreesSettingsPanel` in `apps/web/src/components/settings/SettingsPanels.tsx`
- nav entry + path union in `apps/web/src/components/settings/SettingsSidebarNav.tsx:26-49`

Content:

- List of managed worktrees with badges: dirty, unpushed, merged, orphaned, settled-only,
  linked-thread count. Sort: needs-attention first, then by lastActivity ascending.
- "Needs attention" grouping for dirty-but-inactive worktrees with the explanatory copy from
  decision 3.
- Filtering (client-side over the loaded inventory — no new RPC surface):
  - free-text search matching branch name, directory name, and linked thread titles
  - project filter (the page is global; with several projects the list interleaves otherwise)
  - status filter chips, multi-select: needs attention / safe to prune / dirty / unpushed /
    orphaned / settled-only
  - the bulk "Prune N safe worktrees" action operates on the *filtered* set when filters are
    active, and the button label must reflect that (e.g. "Prune 12 safe worktrees (filtered)")
  - filter state is ephemeral (not persisted) in v1
- Row actions: delete (safe rows: plain confirm; dirty/unpushed rows: destructive-styled
  confirm spelling out that uncommitted changes / unpushed commits are permanently lost).
- Bulk action: "Prune N safe worktrees".
- Policy controls (global):
  - auto-prune enabled on/off
  - inactivity window: 7 / 14 (default) / 30 days
  - "delete orphaned worktrees immediately" toggle
- Deleting never deletes threads; threads keep their `branch`/`worktreePath` metadata for
  revival.

Open implementation question: where the policy settings persist. The sweep runs server-side,
so the policy must be server-readable — unlike e.g. `sidebarAutoSettleAfterDays`, which is a
client-side setting (`BetaSettingsPanel.tsx:12-14`). Resolve during implementation: either an
existing server-persisted settings mechanism if one exists, or a small server settings
store + RPC.

### 3. Auto-prune sweep (server)

Periodic loop on the `ProviderSessionReaper` pattern
(`apps/server/src/provider/Layers/ProviderSessionReaper.ts:106-131` — `Effect.forkScoped` +
`Schedule.spaced`), started from `serverRuntimeStartup.ts` like the reaper (`:345`). Cadence:
hourly-ish; exact interval is uninteresting as long as it also runs once shortly after startup.

Each sweep, per project: build inventory → remove auto-prunable worktrees via existing
`removeWorktree` (`GitVcsDriverCore.ts:2393-2405`, without `--force` — a non-forced
`git worktree remove` refusing due to unexpected dirt is a desirable last-line safety net) →
finish with `git worktree prune` (new driver op) to clear stale admin entries. Log a concise
summary event/line of what was removed and what was skipped-with-reason (feeds the
"needs attention" UI).

Also handle decision 5's immediate mode: when `thread.delete` orphans a worktree and the
"delete orphans immediately" setting is on, the server removes it (if safe) without any
client dialog — this replaces the desktop-only prompt path as the mechanism; the web/desktop
delete flow keeps its dialog purely as UX when the setting is off.

### 4. Revival on unsettle

When a thread becomes active again (explicit unsettle, or the existing auto-unsettle-on-
activity in `decider.ts:785-799` etc.) — or when a turn starts — and its `worktreePath` no
longer exists on disk: recreate it in `bootstrap.prepareWorktree` (`ws.ts:1011-1041`) via
`git worktree add <path> <branch>` on the thread's existing branch (branch always survives
v1 pruning). If the branch is somehow gone (user deleted it manually), fail with a clear
error offering to recreate from the base branch. Checkpoint refs survive pruning, so
diff/revert history remains intact after revival.

### 5. Minimal CLI (stretch)

`t3 worktrees list` (table from the inventory) and `t3 worktrees prune [--dry-run]`
(safe set only; no force flag in v1). New file in `apps/server/src/cli/`, patterned on
`project.ts`. Cut first if v1 needs trimming — the settings page's bulk prune covers the
acute 186-worktree cleanup.

## Build order

1. Inventory service + `vcsListWorktrees`/`vcsPruneWorktrees` RPC
2. Worktrees settings page (observability + manual/bulk delete) — solves the acute pain
3. Policy settings + auto-prune sweep + orphan-immediate handling + server-side removal on
   thread delete
4. Revival on missing worktree
5. CLI (stretch)

## Out of scope for v1

- Branch deletion / checkpoint-ref GC
- Safety snapshots of dirty state before deletion
- Per-project policy overrides
- Any migration/backfill beyond what the inventory naturally surfaces (existing orphans just
  show up as prunable)
