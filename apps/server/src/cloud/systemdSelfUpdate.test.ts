import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import {
  SystemdSelfUpdateActivationError,
  SystemdSelfUpdatePlan,
  SystemdSelfUpdateReceipt,
  activateSystemdSelfUpdatePlan,
  waitForSystemdSelfUpdateReadiness,
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
        serviceUnit: "t3code-self-update-test.service",
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
          ["--user", "restart", "t3code-self-update-test.service"],
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
                      operation: "await-readiness",
                      expectedVersion: input.expectedVersion,
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
          ["--user", "restart", "t3code-self-update-test.service"],
          ["--user", "daemon-reload"],
          ["--user", "reset-failed", "t3code-self-update-test.service"],
          ["--user", "restart", "t3code-self-update-test.service"],
        ],
      );
      const receipt = yield* readReceipt(fixture.receiptPath);
      assert.equal(receipt.phase, "rolled-back");
      assert.equal(receipt.detail, "The restarted server did not become ready as t3@0.0.29.");
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
              operation: "await-readiness",
              expectedVersion: input.expectedVersion,
            }),
          ),
        { restartDelay: Duration.zero },
      ).pipe(Effect.provide(makeRunnerLayer(commands)), Effect.flip);

      assert.include(error.message, "previous server could not be restored");
      assert.equal((yield* readReceipt(fixture.receiptPath)).phase, "recovery-failed");
    }),
  );

  it.effect("probes the runtime-readiness endpoint on the replacement process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-systemd-ready-test-" });
      const runtimeStatePath = path.join(directory, "server-runtime.json");
      const encodeRuntimeState = Schema.encodeEffect(
        Schema.fromJsonString(PersistedServerRuntimeState),
      );
      const encodedRuntimeState = yield* encodeRuntimeState({
        version: 1,
        pid: 456,
        port: 3210,
        origin: "http://127.0.0.1:3210",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* fs.writeFileString(runtimeStatePath, `${encodedRuntimeState}\n`);

      const requests: Array<string> = [];
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                environmentId: "environment-test",
                label: "Test environment",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.29",
                capabilities: { repositoryIdentity: true },
              }),
            ),
          );
        }),
      );

      yield* waitForSystemdSelfUpdateReadiness({
        expectedVersion: "0.0.29",
        previousPid: 123,
        runtimeStatePath,
      }).pipe(Effect.provide(httpClientLayer));

      assert.deepEqual(requests, ["http://127.0.0.1:3210/.well-known/t3/ready"]);
    }),
  );
});
