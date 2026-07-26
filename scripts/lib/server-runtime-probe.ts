/**
 * Whether a T3 Code server is currently running against a data directory.
 *
 * A maintained copy of the parts of `apps/server/src/serverRuntimeState.ts` that
 * host scripts need: that package exposes no importable surface to `scripts/`,
 * the same reason `./projection-tables.ts` exists. Only the fields read here are
 * modelled, so a server that adds a field stays readable.
 */
// @effect-diagnostics nodeBuiltinImport:off - the sync probe runs inside a
// synchronous SQLite transaction, where the platform layer is not available.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** The two state directories `deriveServerPaths` can select. */
const STATE_DIRS = ["dev", "userdata"] as const;

/**
 * The runtime-state file is removed by a release finalizer, so a server killed
 * with SIGKILL — or one that crashed — leaves it behind. Signal 0 runs the
 * permission and existence checks without delivering a signal, which is what
 * distinguishes "still running" from "left this here on the way out".
 *
 * PIDs are reused eventually, so a false positive is possible in principle. For
 * a guard on a destructive local-dev command that errs the safe way: the worst
 * case is being told to stop a server that is already stopped.
 */
const isPidLive = (pid: number): boolean => {
  // `process.kill` reads non-positive pids as signal-group targets rather than
  // process lookups — 0 signals the caller's own group, -1 every permitted
  // process — so neither throws and both would report "live" unconditionally.
  // The schema rejects those, and this repeats the check so the invariant
  // travels with the code that depends on it.
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to another user. An
    // out-of-range pid throws a TypeError instead, which has no errno.
    return typeof cause === "object" && cause !== null && "code" in cause
      ? cause.code === "EPERM"
      : false;
  }
};

/**
 * The pid of a live server whose state file sits in one directory.
 *
 * Synchronous because its main caller runs inside `seedDevDatabase`'s open
 * SQLite transaction, where nothing can await. Applies one rule everywhere: a
 * positive live pid counts, anything unparseable does not — a malformed or
 * half-written file says nothing about liveness, and treating it as "a server
 * is up" would block seeding with no way to clear it.
 */
function findPidInStateDir(baseDir: string, stateDir: string): number | undefined {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(NodePath.join(baseDir, stateDir, "server-runtime.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const pid: unknown = (parsed as { pid?: unknown } | null)?.pid;
    return typeof pid === "number" && isPidLive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pid of a live server under `baseDir`, if any.
 *
 * `stateDir` scopes the probe to one state directory when the caller has
 * already resolved which database it is about to touch — a server using only
 * the *other* directory's database is not a conflict and must not block it.
 * Omitted, both directories count, for callers guarding the base as a whole.
 */
export function findRunningServerPidSync(baseDir: string, stateDir?: string): number | undefined {
  for (const candidate of stateDir === undefined ? STATE_DIRS : [stateDir]) {
    const pid = findPidInStateDir(baseDir, candidate);
    if (pid !== undefined) {
      return pid;
    }
  }
  return undefined;
}

/** {@link findRunningServerPidSync} for Effect callers. */
export const findRunningServerPid = (
  baseDir: string,
  stateDir?: string,
): Effect.Effect<Option.Option<number>> =>
  Effect.sync(() => Option.fromNullishOr(findRunningServerPidSync(baseDir, stateDir)));
