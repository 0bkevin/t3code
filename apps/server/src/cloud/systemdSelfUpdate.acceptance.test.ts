// @effect-diagnostics nodeBuiltinImport:off
/**
 * Opt-in acceptance coverage for the real systemd handoff and rollback path.
 * Every unit and file is uniquely named; this must never target t3code.service.
 *
 * Run on Linux with a user manager:
 * T3_SYSTEMD_SELF_UPDATE_ACCEPTANCE=1 vp test run \
 *   apps/server/src/cloud/systemdSelfUpdate.acceptance.test.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { quoteSystemdValue } from "./bootService.ts";
import {
  SystemdSelfUpdatePlan,
  SystemdSelfUpdateReceipt,
  waitForSystemdSelfUpdateReadiness,
  writeSystemdSelfUpdatePlan,
} from "./systemdSelfUpdate.ts";

const OLD_VERSION = "0.0.28";
const TARGET_VERSION = "0.0.29";
const decodeLaunch = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      pid: Schema.Int,
      version: Schema.String,
    }),
  ),
);

const fixtureServerSource = `
import * as fs from "node:fs";
import * as http from "node:http";

const [runtimeStatePath, launchesPath, version, readiness] = process.argv.slice(2);
const descriptor = {
  environmentId: "systemd-self-update-acceptance",
  label: "Systemd self-update acceptance",
  platform: { os: "linux", arch: "x64" },
  serverVersion: version,
  capabilities: { repositoryIdentity: true },
};
const server = http.createServer((request, response) => {
  if (request.url === "/.well-known/t3/ready" && readiness === "ready") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(descriptor));
    return;
  }
  response.writeHead(503);
  response.end();
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(1);
  fs.appendFileSync(launchesPath, JSON.stringify({ pid: process.pid, version }) + "\\n");
  fs.writeFileSync(runtimeStatePath, JSON.stringify({
    version: 1,
    pid: process.pid,
    port: address.port,
    origin: "http://127.0.0.1:" + address.port,
    startedAt: new Date().toISOString(),
  }) + "\\n");
});
`;

const runAcceptanceScenario = Effect.fn("test.runSystemdSelfUpdateAcceptance")(function* (
  scenario: "healthy" | "rollback",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const home = process.env.HOME;
  if (!home) {
    return yield* Effect.die(new Error("HOME is required for a systemd user-manager test."));
  }

  const directory = yield* fs.makeTempDirectoryScoped({ prefix: `t3-systemd-${scenario}-` });
  const runtimeStatePath = path.join(directory, "server-runtime.json");
  const launchesPath = path.join(directory, "launches.jsonl");
  const receiptPath = path.join(directory, "receipt.json");
  const planPath = path.join(directory, "plan.json");
  const fixtureServerPath = path.join(directory, "fixture-server.mjs");
  yield* fs.writeFileString(fixtureServerPath, fixtureServerSource);

  const suffix = `${String(process.pid)}-${String(yield* Clock.currentTimeMillis)}-${scenario}`;
  const serviceUnit = `t3code-self-update-acceptance-${suffix}.service`;
  const helperUnit = `t3code-self-update-acceptance-helper-${suffix}.service`;
  const userUnitDirectory = path.join(home, ".config", "systemd", "user");
  const unitPath = path.join(userUnitDirectory, serviceUnit);
  yield* fs.makeDirectory(userUnitDirectory, { recursive: true });

  const renderUnit = (version: string, readiness: "ready" | "blocked") =>
    [
      "[Unit]",
      "Description=T3 self-update acceptance fixture",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${quoteSystemdValue(process.execPath)} ${quoteSystemdValue(fixtureServerPath)} ${quoteSystemdValue(runtimeStatePath)} ${quoteSystemdValue(launchesPath)} ${version} ${readiness}`,
      "Restart=no",
      "TimeoutStopSec=5",
      "",
    ].join("\n");
  const previousUnit = renderUnit(OLD_VERSION, "ready");
  const nextUnit = renderUnit(TARGET_VERSION, scenario === "healthy" ? "ready" : "blocked");

  const systemctl = (args: ReadonlyArray<string>) =>
    runner.run({ command: "systemctl", args: ["--user", ...args] });
  const cleanup = Effect.gen(function* () {
    yield* systemctl(["stop", helperUnit, serviceUnit]).pipe(Effect.ignore);
    yield* systemctl(["reset-failed", helperUnit, serviceUnit]).pipe(Effect.ignore);
    yield* fs.remove(unitPath, { force: true }).pipe(Effect.ignore);
    yield* systemctl(["daemon-reload"]).pipe(Effect.ignore);
  });
  yield* Effect.addFinalizer(() => cleanup);

  yield* fs.writeFileString(unitPath, previousUnit);
  const reload = yield* systemctl(["daemon-reload"]);
  assert.equal(Number(reload.code), 0);
  const start = yield* systemctl(["start", serviceUnit]);
  assert.equal(Number(start.code), 0);
  yield* waitForSystemdSelfUpdateReadiness(
    {
      expectedVersion: OLD_VERSION,
      previousPid: 0,
      runtimeStatePath,
    },
    { timeout: Duration.seconds(10), interval: Duration.millis(100) },
  );
  const initialState = yield* readPersistedServerRuntimeState(runtimeStatePath);
  if (Option.isNone(initialState)) {
    return yield* Effect.die(
      new Error("The disposable systemd service did not publish runtime state."),
    );
  }

  const plan = new SystemdSelfUpdatePlan({
    version: 1,
    fromVersion: OLD_VERSION,
    targetVersion: TARGET_VERSION,
    currentPid: initialState.value.pid,
    serviceUnit,
    unitPath,
    previousUnit,
    nextUnit,
    runtimeStatePath,
    receiptPath,
  });
  yield* writeSystemdSelfUpdatePlan(planPath, plan);

  const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
  const cliEntryPath = path.join(repositoryRoot, "apps", "server", "src", "bin.ts");
  const handoff = yield* runner.run({
    command: "systemd-run",
    args: [
      "--user",
      "--wait",
      "--collect",
      "--service-type=exec",
      `--unit=${helperUnit}`,
      process.execPath,
      "--experimental-strip-types",
      cliEntryPath,
      "service",
      "_apply-update",
      "--plan",
      planPath,
    ],
    timeout: Duration.seconds(90),
  });
  assert.equal(Number(handoff.code), 0, handoff.stderr);

  const receipt = yield* fs
    .readFileString(receiptPath)
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SystemdSelfUpdateReceipt))),
    );
  assert.equal(receipt.phase, scenario === "healthy" ? "healthy" : "rolled-back");
  assert.equal(
    yield* fs.readFileString(unitPath),
    scenario === "healthy" ? nextUnit : previousUnit,
  );

  yield* waitForSystemdSelfUpdateReadiness(
    {
      expectedVersion: scenario === "healthy" ? TARGET_VERSION : OLD_VERSION,
      previousPid: initialState.value.pid,
      runtimeStatePath,
    },
    { timeout: Duration.seconds(10), interval: Duration.millis(100) },
  );
  const launches = (yield* fs.readFileString(launchesPath))
    .trim()
    .split("\n")
    .map((line) => decodeLaunch(line));
  assert.deepEqual(
    launches.map(({ version }) => version),
    scenario === "healthy"
      ? [OLD_VERSION, TARGET_VERSION]
      : [OLD_VERSION, TARGET_VERSION, OLD_VERSION],
  );
});

describe.runIf(process.env.T3_SYSTEMD_SELF_UPDATE_ACCEPTANCE === "1")(
  "systemd self-update acceptance",
  () => {
    const layer = ProcessRunner.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.merge(FetchHttpClient.layer),
    );

    it.live(
      "keeps the helper alive while replacing the host service",
      () => runAcceptanceScenario("healthy").pipe(Effect.provide(layer)),
      30_000,
    );

    it.live(
      "rolls back a server that binds HTTP without becoming runtime-ready",
      () => runAcceptanceScenario("rollback").pipe(Effect.provide(layer)),
      120_000,
    );
  },
);
