// @effect-diagnostics nodeBuiltinImport:off - exercises the executable path guard in a child process.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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

    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(import.meta.dirname, "dev-seed.ts"),
        "--from",
        NodePath.join(root, "source"),
        "--to",
        targetBaseDir,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", T3CODE_HOME: sharedHome },
      },
    );

    assert.notEqual(result.status, 0);
    assert.include(
      `${result.stdout}${result.stderr}`,
      "that database lives in the shared T3 Code home",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(sharedStateDir, "state.sqlite"), "utf8"),
      "must stay untouched",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
