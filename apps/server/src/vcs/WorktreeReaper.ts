/**
 * WorktreeReaper - Periodic auto-prune sweep for managed worktrees.
 *
 * Applies the `worktrees` server-settings policy: removes safe-to-prune
 * worktrees whose last activity is older than the configured inactivity
 * window, plus orphaned ones when "delete orphaned immediately" is enabled.
 * Safety is re-validated by WorktreeService.pruneWorktrees on every removal,
 * and dirty worktrees are never touched.
 *
 * @module WorktreeReaper
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { ServerSettingsService } from "../serverSettings.ts";
import { WorktreeService } from "./WorktreeService.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WorktreeReaperOptions {
  readonly sweepIntervalMs?: number;
  readonly initialDelayMs?: number;
}

export class WorktreeReaper extends Context.Service<
  WorktreeReaper,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One sweep pass; exposed for tests and the reactor-triggered path. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/vcs/WorktreeReaper") {}

export const makeWorktreeReaper = (options?: WorktreeReaperOptions) =>
  Effect.gen(function* () {
    const worktreeService = yield* WorktreeService;
    const serverSettings = yield* ServerSettingsService;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const initialDelayMs = Math.max(0, options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);

    const runSweep = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const policy = settings.worktrees;
      if (policy.autoPruneAfterDays === null && !policy.deleteOrphanedImmediately) {
        return;
      }

      const { worktrees } = yield* worktreeService.listWorktrees({});
      const now = yield* Clock.currentTimeMillis;
      const cutoffMs =
        policy.autoPruneAfterDays === null ? null : now - policy.autoPruneAfterDays * DAY_MS;

      const candidates = worktrees.filter((worktree) => {
        if (!worktree.safeToPrune) return false;
        if (policy.deleteOrphanedImmediately && worktree.orphaned) return true;
        if (cutoffMs === null || worktree.lastActivityAt === null) return false;
        const lastActivityMs = Date.parse(worktree.lastActivityAt);
        return !Number.isNaN(lastActivityMs) && lastActivityMs < cutoffMs;
      });
      if (candidates.length === 0) {
        return;
      }

      const result = yield* worktreeService.pruneWorktrees({
        paths: candidates.map((worktree) => worktree.path),
      });
      yield* Effect.logInfo("worktree.reaper.sweep-complete", {
        candidateCount: candidates.length,
        removedCount: result.removed.length,
        skippedCount: result.skipped.length,
        autoPruneAfterDays: policy.autoPruneAfterDays,
        deleteOrphanedImmediately: policy.deleteOrphanedImmediately,
      });
    });

    const sweep = runSweep.pipe(
      Effect.catch((error: unknown) =>
        Effect.logWarning("worktree.reaper.sweep-failed", { error }),
      ),
      Effect.catchDefect((defect: unknown) =>
        Effect.logWarning("worktree.reaper.sweep-defect", { defect }),
      ),
    );

    const start = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Effect.sleep(Duration.millis(initialDelayMs)).pipe(
            Effect.andThen(
              sweep.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
            ),
          ),
        );
        yield* Effect.logInfo("worktree.reaper.started", {
          sweepIntervalMs,
          initialDelayMs,
        });
      });

    return WorktreeReaper.of({ start, sweep });
  });

export const layer = Layer.effect(WorktreeReaper, makeWorktreeReaper());

export const layerWith = (options: WorktreeReaperOptions) =>
  Layer.effect(WorktreeReaper, makeWorktreeReaper(options));
