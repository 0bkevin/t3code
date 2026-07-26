/**
 * Whether a T3 Code server is currently running against a data directory.
 *
 * A maintained copy of the parts of `apps/server/src/serverRuntimeState.ts` that
 * host scripts need: that package exposes no importable surface to `scripts/`,
 * the same reason `./projection-tables.ts` exists. Only the fields read here are
 * modelled, so a server that adds a field stays readable.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** The two state directories `deriveServerPaths` can select. */
const STATE_DIRS = ["dev", "userdata"] as const;

const RuntimeStateProbe = Schema.Struct({
  pid: Schema.Int,
});

const decodeRuntimeStateProbe = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeStateProbe),
);

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
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to another user.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The pid of a live server under `baseDir`, if any.
 *
 * Both state directories are checked because which one a given server chose
 * depends on flags the caller of this should not have to reason about — the
 * same reason `auth pairing url` checks both.
 */
export const findRunningServerPid = Effect.fn("findRunningServerPid")(function* (baseDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (const stateDir of STATE_DIRS) {
    const statePath = path.join(baseDir, stateDir, "server-runtime.json");
    const raw = yield* fileSystem.readFileString(statePath).pipe(Effect.option);
    if (Option.isNone(raw)) {
      continue;
    }
    // A malformed or half-written file says nothing about liveness; treating it
    // as "a server is up" would block seeding with no way to clear it.
    const state = yield* decodeRuntimeStateProbe(raw.value).pipe(Effect.option);
    if (Option.isSome(state) && isPidLive(state.value.pid)) {
      return Option.some(state.value.pid);
    }
  }

  return Option.none<number>();
});
