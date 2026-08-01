import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { BOOT_SERVICE_UNIT_FILE } from "./bootService.ts";

export const SYSTEMD_SELF_UPDATE_UNIT = "t3code-self-update.service";
export const SYSTEMD_SELF_UPDATE_DIRECTORY = "self-update";
export const SYSTEMD_SELF_UPDATE_PLAN_FILE = "plan.json";
export const SYSTEMD_SELF_UPDATE_RECEIPT_FILE = "receipt.json";

const DEFAULT_RESTART_DELAY = Duration.seconds(2);
const DEFAULT_READINESS_TIMEOUT = Duration.seconds(60);
const DEFAULT_READINESS_INTERVAL = Duration.millis(500);
const READINESS_REQUEST_TIMEOUT = Duration.seconds(2);
const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";

export class SystemdSelfUpdatePlan extends Schema.Class<SystemdSelfUpdatePlan>(
  "SystemdSelfUpdatePlan",
)({
  version: Schema.Literal(1),
  fromVersion: Schema.String,
  targetVersion: Schema.String,
  currentPid: Schema.Int,
  unitPath: Schema.String,
  previousUnit: Schema.String,
  nextUnit: Schema.String,
  runtimeStatePath: Schema.String,
  receiptPath: Schema.String,
}) {}

export const SystemdSelfUpdateReceipt = Schema.Struct({
  version: Schema.Literal(1),
  targetVersion: Schema.String,
  phase: Schema.Literals(["prepared", "activating", "healthy", "rolled-back", "recovery-failed"]),
  updatedAt: Schema.String,
  detail: Schema.optional(Schema.String),
});
export type SystemdSelfUpdateReceipt = typeof SystemdSelfUpdateReceipt.Type;

export const SystemdSelfUpdateOperation = Schema.Literals([
  "read-plan",
  "write-unit",
  "daemon-reload",
  "restart",
  "reset-failed",
  "await-readiness",
  "recover",
]);
export type SystemdSelfUpdateOperation = typeof SystemdSelfUpdateOperation.Type;

export class SystemdSelfUpdateActivationError extends Schema.TaggedErrorClass<SystemdSelfUpdateActivationError>()(
  "SystemdSelfUpdateActivationError",
  {
    operation: SystemdSelfUpdateOperation,
    path: Schema.optional(Schema.String),
    expectedVersion: Schema.optional(Schema.String),
    actualVersion: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const exitCode = this.exitCode === undefined ? "" : ` (exit code ${String(this.exitCode)})`;
    switch (this.operation) {
      case "read-plan":
        return `Could not read the staged update plan${this.path === undefined ? "" : ` at ${this.path}`}.`;
      case "write-unit":
        return "Could not write the systemd boot service unit.";
      case "daemon-reload":
        return `Could not reload systemd units${exitCode}.`;
      case "restart":
        return `Could not restart the systemd boot service${exitCode}.`;
      case "reset-failed":
        return `Could not reset the failed systemd boot service${exitCode}.`;
      case "await-readiness":
        return this.actualVersion === undefined
          ? `The restarted server did not become ready${this.expectedVersion === undefined ? "" : ` as t3@${this.expectedVersion}`}.`
          : `The restarted server reported t3@${this.actualVersion}, expected t3@${this.expectedVersion ?? "unknown"}.`;
      case "recover":
        return "The update failed and the previous server could not be restored.";
    }
  }
}

const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(SystemdSelfUpdatePlan));
const encodePlan = Schema.encodeEffect(Schema.fromJsonString(SystemdSelfUpdatePlan));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(SystemdSelfUpdateReceipt));

const provideFileServices = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) =>
  effect.pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

const writeAtomically = (
  filePath: string,
  contents: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) => provideFileServices(writeFileStringAtomically({ filePath, contents }), fs, path);

export const writeSystemdSelfUpdatePlan = Effect.fn("systemdSelfUpdate.writePlan")(function* (
  planPath: string,
  plan: SystemdSelfUpdatePlan,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const encoded = yield* encodePlan(plan);
  yield* writeAtomically(planPath, `${encoded}\n`, fs, path);
  yield* writeReceipt(plan, "prepared");
});

const writeReceipt = Effect.fn("systemdSelfUpdate.writeReceipt")(function* (
  plan: SystemdSelfUpdatePlan,
  phase: SystemdSelfUpdateReceipt["phase"],
  detail?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* DateTime.now;
  const receipt = {
    version: 1,
    targetVersion: plan.targetVersion,
    phase,
    updatedAt: DateTime.formatIso(now),
    ...(detail === undefined ? {} : { detail }),
  } satisfies SystemdSelfUpdateReceipt;
  const encoded = yield* encodeReceipt(receipt);
  yield* writeAtomically(plan.receiptPath, `${encoded}\n`, fs, path);
});

const runSystemctl = Effect.fn("systemdSelfUpdate.runSystemctl")(function* (
  args: ReadonlyArray<string>,
  operation: Extract<SystemdSelfUpdateOperation, "daemon-reload" | "restart" | "reset-failed">,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({ command: "systemctl", args }).pipe(
    Effect.mapError(
      (cause) =>
        new SystemdSelfUpdateActivationError({
          operation,
          cause,
        }),
    ),
  );
  if (result.code !== 0) {
    return yield* new SystemdSelfUpdateActivationError({
      operation,
      exitCode: Number(result.code),
    });
  }
});

const installUnit = Effect.fn("systemdSelfUpdate.installUnit")(function* (
  plan: SystemdSelfUpdatePlan,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* writeAtomically(plan.unitPath, contents, fs, path).pipe(
    Effect.mapError(
      (cause) =>
        new SystemdSelfUpdateActivationError({
          operation: "write-unit",
          path: plan.unitPath,
          cause,
        }),
    ),
  );
  yield* runSystemctl(["--user", "daemon-reload"], "daemon-reload");
});

const restartBootService = runSystemctl(["--user", "restart", BOOT_SERVICE_UNIT_FILE], "restart");

export interface SystemdSelfUpdateReadinessInput {
  readonly expectedVersion: string;
  readonly previousPid: number;
  readonly runtimeStatePath: string;
}

export const waitForSystemdSelfUpdateReadiness = Effect.fn("systemdSelfUpdate.waitForReadiness")(
  function* (
    input: SystemdSelfUpdateReadinessInput,
    options: {
      readonly timeout?: Duration.Input;
      readonly interval?: Duration.Input;
    } = {},
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = yield* HttpClient.HttpClient;
    const attempt = Effect.gen(function* () {
      const state = yield* provideFileServices(
        readPersistedServerRuntimeState(input.runtimeStatePath),
        fs,
        path,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SystemdSelfUpdateActivationError({
              operation: "await-readiness",
              expectedVersion: input.expectedVersion,
              cause,
            }),
        ),
      );
      if (Option.isNone(state) || state.value.pid === input.previousPid) {
        return yield* new SystemdSelfUpdateActivationError({
          operation: "await-readiness",
          expectedVersion: input.expectedVersion,
        });
      }

      const request = HttpClientRequest.get(
        new URL(WELL_KNOWN_ENVIRONMENT_PATH, state.value.origin).toString(),
      );
      const descriptor = yield* client.execute(request).pipe(
        Effect.timeout(READINESS_REQUEST_TIMEOUT),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
        Effect.mapError(
          (cause) =>
            new SystemdSelfUpdateActivationError({
              operation: "await-readiness",
              expectedVersion: input.expectedVersion,
              cause,
            }),
        ),
      );
      if (descriptor.serverVersion !== input.expectedVersion) {
        return yield* new SystemdSelfUpdateActivationError({
          operation: "await-readiness",
          expectedVersion: input.expectedVersion,
          actualVersion: descriptor.serverVersion,
        });
      }
    });

    const ready = yield* attempt.pipe(
      Effect.retry(Schedule.spaced(options.interval ?? DEFAULT_READINESS_INTERVAL)),
      Effect.timeoutOption(options.timeout ?? DEFAULT_READINESS_TIMEOUT),
    );
    if (Option.isNone(ready)) {
      return yield* new SystemdSelfUpdateActivationError({
        operation: "await-readiness",
        expectedVersion: input.expectedVersion,
      });
    }
  },
);

export const activateSystemdSelfUpdatePlan = Effect.fn("systemdSelfUpdate.activatePlan")(function* <
  R,
>(
  plan: SystemdSelfUpdatePlan,
  waitForReadiness: (
    input: SystemdSelfUpdateReadinessInput,
  ) => Effect.Effect<void, SystemdSelfUpdateActivationError, R>,
  options: { readonly restartDelay?: Duration.Input } = {},
) {
  const activate = Effect.gen(function* () {
    yield* writeReceipt(plan, "activating").pipe(Effect.ignore);
    yield* Effect.sleep(options.restartDelay ?? DEFAULT_RESTART_DELAY);
    yield* installUnit(plan, plan.nextUnit);
    yield* restartBootService;
    yield* waitForReadiness({
      expectedVersion: plan.targetVersion,
      previousPid: plan.currentPid,
      runtimeStatePath: plan.runtimeStatePath,
    });
    yield* writeReceipt(plan, "healthy").pipe(Effect.ignore);
  });

  yield* activate.pipe(
    Effect.catch((activationError) =>
      Effect.gen(function* () {
        yield* Effect.logError("Systemd self-update failed; restoring the previous version.").pipe(
          Effect.annotateLogs({
            targetVersion: plan.targetVersion,
            operation: activationError.operation,
            error: activationError.message,
          }),
        );
        const recovery = Effect.gen(function* () {
          yield* installUnit(plan, plan.previousUnit);
          yield* runSystemctl(["--user", "reset-failed", BOOT_SERVICE_UNIT_FILE], "reset-failed");
          yield* restartBootService;
          yield* waitForReadiness({
            expectedVersion: plan.fromVersion,
            previousPid: plan.currentPid,
            runtimeStatePath: plan.runtimeStatePath,
          });
          yield* writeReceipt(plan, "rolled-back", activationError.message).pipe(Effect.ignore);
        });

        yield* recovery.pipe(
          Effect.catch((recoveryError) =>
            writeReceipt(plan, "recovery-failed", recoveryError.message).pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.fail(
                  new SystemdSelfUpdateActivationError({
                    operation: "recover",
                    cause: { activationError, recoveryError },
                  }),
                ),
              ),
            ),
          ),
        );
      }),
    ),
  );
});

export const applySystemdSelfUpdatePlan = Effect.fn("systemdSelfUpdate.applyPlan")(function* (
  planPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const plan = yield* fs.readFileString(planPath).pipe(
    Effect.flatMap(decodePlan),
    Effect.mapError(
      (cause) =>
        new SystemdSelfUpdateActivationError({
          operation: "read-plan",
          path: planPath,
          cause,
        }),
    ),
  );
  yield* activateSystemdSelfUpdatePlan(plan, waitForSystemdSelfUpdateReadiness);
});
