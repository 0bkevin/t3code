// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { readWorkflowScript } from "./workflowScriptQuery.ts";

const root = NodePath.join(NodeOS.homedir(), ".claude", "projects", "__wf_script_test__");
NodeFS.mkdirSync(root, { recursive: true });
const scriptPath = NodePath.join(root, "run.js");
NodeFS.writeFileSync(scriptPath, "export const meta = {};\n");
const outside = NodePath.join(NodeOS.tmpdir(), "wf-outside.js");
NodeFS.writeFileSync(outside, "evil\n");
const link = NodePath.join(root, "sneaky.js");
try {
  NodeFS.symlinkSync(outside, link);
} catch {
  // pre-existing from a prior run
}

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(outside, { force: true });
});

describe("readWorkflowScript containment", () => {
  it("serves a real script under the projects root", async () => {
    const result = await Effect.runPromise(readWorkflowScript({ scriptPath }));
    expect(result.contents).toContain("export const meta");
    expect(result.truncated).toBe(false);
  });

  it("rejects relative and non-js paths", async () => {
    await expect(Effect.runPromise(readWorkflowScript({ scriptPath: "run.js" }))).rejects.toThrow();
    await expect(
      Effect.runPromise(readWorkflowScript({ scriptPath: scriptPath.replace(".js", ".ts") })),
    ).rejects.toThrow();
  });

  it("rejects paths outside the root and symlink escapes", async () => {
    await expect(Effect.runPromise(readWorkflowScript({ scriptPath: outside }))).rejects.toThrow();
    // A symlink INSIDE the root pointing outside must also fail (realpath
    // re-containment of the leaf).
    await expect(Effect.runPromise(readWorkflowScript({ scriptPath: link }))).rejects.toThrow();
  });
});
