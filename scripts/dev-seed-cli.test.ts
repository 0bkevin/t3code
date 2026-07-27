// @effect-diagnostics nodeBuiltinImport:off - exercises the executable path guard in a child process.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const runDevSeed = (input: {
  readonly root: string;
  readonly targetBaseDir: string;
  readonly t3Home: string;
}) =>
  NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(import.meta.dirname, "dev-seed.ts"),
      "--from",
      NodePath.join(input.root, "source"),
      "--to",
      input.targetBaseDir,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", T3CODE_HOME: input.t3Home },
    },
  );

const assertSharedHomeRefusal = (result: ReturnType<typeof runDevSeed>) => {
  assert.notEqual(result.status, 0);
  assert.include(
    `${result.stdout}${result.stderr}`,
    "that database lives in the shared T3 Code home",
  );
};

it("refuses to seed a target inside T3CODE_HOME through a symlink", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-seed-cli-"));
  try {
    const sharedHome = NodePath.join(root, "shared");
    const sharedStateDir = NodePath.join(sharedHome, "userdata");
    const targetBaseDir = NodePath.join(root, "target");
    NodeFS.mkdirSync(sharedStateDir, { recursive: true });
    NodeFS.mkdirSync(targetBaseDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(sharedStateDir, "state.sqlite"), "must stay untouched");
    NodeFS.symlinkSync(sharedStateDir, NodePath.join(targetBaseDir, "userdata"), "dir");

    const result = runDevSeed({ root, targetBaseDir, t3Home: sharedHome });

    assertSharedHomeRefusal(result);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(sharedStateDir, "state.sqlite"), "utf8"),
      "must stay untouched",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses targets when T3CODE_HOME resolves to the filesystem root", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-seed-root-cli-"));
  try {
    const sharedHome = NodePath.join(root, "shared");
    const targetBaseDir = NodePath.join(root, "target");
    const targetStateDir = NodePath.join(targetBaseDir, "userdata");
    NodeFS.symlinkSync(NodePath.parse(root).root, sharedHome, "dir");
    NodeFS.mkdirSync(targetStateDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(targetStateDir, "state.sqlite"), "must stay untouched");

    const result = runDevSeed({ root, targetBaseDir, t3Home: sharedHome });

    assertSharedHomeRefusal(result);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(targetStateDir, "state.sqlite"), "utf8"),
      "must stay untouched",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
