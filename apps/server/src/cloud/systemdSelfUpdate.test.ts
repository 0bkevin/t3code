import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  SystemdSelfUpdateActivationError,
  SystemdSelfUpdatePlan,
  SystemdSelfUpdateReceipt,
  activateSystemdSelfUpdatePlan,
} from "./systemdSelfUpdate.ts";

interface RecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const makeRunnerLayer = (commands: Array<RecordedCommand>) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          commands.push({ command: input.command, args: input.args });
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    }),
  );

it.layer(NodeServices.layer)("systemd self-update activation", (it) => {
  const makeFixture = Effect.fn("test.makeSystemdUpdateFixture")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-systemd-update-test-" });
    const unitPath = path.join(directory, "t3code.service");
    const receiptPath = path.join(directory, "receipt.json");
    const previousUnit = "old unit\n";
    yield* fs.writeFileString(unitPath, previousUnit);
    return {
      fs,
      unitPath,
      receiptPath,
      previousUnit,
      plan: new SystemdSelfUpdatePlan({
        version: 1,
        fromVersion: "0.0.28",
        targetVersion: "0.0.29",
        currentPid: 123,
        unitPath,
        previousUnit,
        nextUnit: "new unit\n",
        runtimeStatePath: path.join(directory, "server-runtime.json"),
        receiptPath,
      }),
    };
  });

  const readReceipt = Effect.fn("test.readSystemdUpdateReceipt")(function* (receiptPath: string) {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(receiptPath)
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SystemdSelfUpdateReceipt))),
      );
  });

  it.effect("activates and verifies the new service from the helper", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const commands: Array<RecordedCommand> = [];
      const readinessVersions: Array<string> = [];

      yield* activateSystemdSelfUpdatePlan(
        fixture.plan,
        (input) => Effect.sync(() => readinessVersions.push(input.expectedVersion)),
        { restartDelay: Duration.zero },
      ).pipe(Effect.provide(makeRunnerLayer(commands)));

      assert.equal(yield* fixture.fs.readFileString(fixture.unitPath), "new unit\n");
      assert.deepEqual(readinessVersions, ["0.0.29"]);
      assert.deepEqual(
        commands.map(({ args }) => args),
        [
          ["--user", "daemon-reload"],
          ["--user", "restart", "t3code.service"],
        ],
      );
      assert.equal((yield* readReceipt(fixture.receiptPath)).phase, "healthy");
    }),
  );

  it.effect("restores and verifies the previous service when the target never becomes ready", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const commands: Array<RecordedCommand> = [];
      const readinessVersions: Array<string> = [];

      yield* activateSystemdSelfUpdatePlan(
        fixture.plan,
        (input) =>
          Effect.sync(() => readinessVersions.push(input.expectedVersion)).pipe(
            Effect.andThen(
              input.expectedVersion === fixture.plan.targetVersion
                ? Effect.fail(
                    new SystemdSelfUpdateActivationError({
                      reason: "target did not become ready",
                    }),
                  )
                : Effect.void,
            ),
          ),
        { restartDelay: Duration.zero },
      ).pipe(Effect.provide(makeRunnerLayer(commands)));

      assert.equal(yield* fixture.fs.readFileString(fixture.unitPath), fixture.previousUnit);
      assert.deepEqual(readinessVersions, ["0.0.29", "0.0.28"]);
      assert.deepEqual(
        commands.map(({ args }) => args),
        [
          ["--user", "daemon-reload"],
          ["--user", "restart", "t3code.service"],
          ["--user", "daemon-reload"],
          ["--user", "reset-failed", "t3code.service"],
          ["--user", "restart", "t3code.service"],
        ],
      );
      const receipt = yield* readReceipt(fixture.receiptPath);
      assert.equal(receipt.phase, "rolled-back");
      assert.equal(receipt.detail, "target did not become ready");
    }),
  );

  it.effect("records a recovery failure instead of claiming the update completed", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const commands: Array<RecordedCommand> = [];
      const error = yield* activateSystemdSelfUpdatePlan(
        fixture.plan,
        (input) =>
          Effect.fail(
            new SystemdSelfUpdateActivationError({
              reason: `${input.expectedVersion} did not become ready`,
            }),
          ),
        { restartDelay: Duration.zero },
      ).pipe(Effect.provide(makeRunnerLayer(commands)), Effect.flip);

      assert.include(error.reason, "previous server could not be restored");
      assert.equal((yield* readReceipt(fixture.receiptPath)).phase, "recovery-failed");
    }),
  );
});
