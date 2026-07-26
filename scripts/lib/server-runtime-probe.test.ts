import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { findRunningServerPid } from "./server-runtime-probe.ts";

/** A pid that cannot belong to a live process (above the usual pid_max). */
const DEAD_PID = 0x7ffffffe;

const writeRuntimeState = Effect.fn(function* (input: {
  readonly baseDir: string;
  readonly stateDir: "dev" | "userdata";
  readonly contents: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(input.baseDir, input.stateDir);
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(directory, "server-runtime.json"), input.contents);
});

const runtimeStateJson = (pid: number) =>
  JSON.stringify({
    version: 1,
    pid,
    port: 16_602,
    origin: "http://127.0.0.1:16602",
    startedAt: "2026-07-20T00:00:00.000Z",
  });

const makeBaseDir = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-runtime-probe-test-" });
});

describe("findRunningServerPid", () => {
  it.effect("reports the pid of a live server in the dev state directory", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir();
      yield* writeRuntimeState({
        baseDir,
        stateDir: "dev",
        contents: runtimeStateJson(process.pid),
      });

      assert.equal(Option.getOrThrow(yield* findRunningServerPid(baseDir)), process.pid);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // An explicit --home-dir puts runtime state in userdata instead, and the
  // caller of a seed has no reason to know which of the two was used.
  it.effect("also finds a live server in the userdata state directory", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir();
      yield* writeRuntimeState({
        baseDir,
        stateDir: "userdata",
        contents: runtimeStateJson(process.pid),
      });

      assert.equal(Option.getOrThrow(yield* findRunningServerPid(baseDir)), process.pid);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // A server killed with SIGKILL never clears its state file. Treating that as
  // "running" would block seeding for good, with nothing to clear it.
  it.effect("ignores a state file whose process is gone", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir();
      yield* writeRuntimeState({ baseDir, stateDir: "dev", contents: runtimeStateJson(DEAD_PID) });

      assert.isTrue(Option.isNone(yield* findRunningServerPid(baseDir)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // A half-written file says nothing about liveness either way.
  it.effect("ignores a state file it cannot parse", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir();
      yield* writeRuntimeState({ baseDir, stateDir: "dev", contents: "{not json" });

      assert.isTrue(Option.isNone(yield* findRunningServerPid(baseDir)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports nothing when no state files exist", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir();
      assert.isTrue(Option.isNone(yield* findRunningServerPid(baseDir)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
