// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to persisted workflow scripts for the Agents surface's
 * "{} script" affordance.
 *
 * Containment rules (lifted from the reviewed #3650 inspection service):
 * - the resolved realpath must live under ~/.claude/projects (where the
 *   Claude harness persists workflow scripts) — realpath re-containment
 *   defeats symlink escapes, including a symlinked leaf file;
 * - only .js leaf files are served;
 * - reads are size-capped rather than failed, with a truncation marker.
 *
 * The client-supplied path is a hint from the workflow's runHandles; it is
 * never trusted beyond these checks.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OrchestrationGetWorkflowScriptError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const SCRIPT_BYTE_CAP = 256 * 1024;

function scriptsRoot(): string {
  return NodePath.join(NodeOS.homedir(), ".claude", "projects");
}

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
}) {
  const requested = input.scriptPath;

  if (!NodePath.isAbsolute(requested) || NodePath.extname(requested) !== ".js") {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({
        message: "Workflow scripts must be absolute .js paths.",
      }),
    );
  }

  const root = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(scriptsRoot()),
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({ message: "Script root unavailable.", cause }),
  });

  // Realpath the FILE itself (not just its directory): a symlink named
  // like a script inside a contained directory must not escape.
  const resolved = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(requested),
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({ message: "Script not found.", cause }),
  });

  if (resolved !== root && !resolved.startsWith(`${root}${NodePath.sep}`)) {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({
        message: "Script path is outside the workflow scripts root.",
      }),
    );
  }
  if (NodePath.extname(resolved) !== ".js") {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({ message: "Resolved script is not a .js file." }),
    );
  }

  // TOCTOU-safe read (review finding): open FIRST, then verify what was
  // actually opened via the file descriptor. Re-checking the path after
  // open would race against a swap; fstat on the handle cannot.
  const read = yield* Effect.tryPromise({
    try: async () => {
      const handle = await NodeFSP.open(resolved, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw new Error("not a regular file");
        }
        // The opened inode must be the same one realpath resolved to: a
        // process swapping the path between realpath and open changes the
        // inode, which this comparison catches.
        const pathStat = await NodeFSP.lstat(resolved);
        if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
          throw new Error("file changed between resolution and open");
        }
        const truncated = stat.size > SCRIPT_BYTE_CAP;
        const buffer = Buffer.alloc(Math.min(stat.size, SCRIPT_BYTE_CAP));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          contents: buffer.subarray(0, bytesRead).toString("utf8"),
          truncated,
        };
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({ message: "Script read failed.", cause }),
  });

  return {
    scriptPath: resolved,
    contents: read.contents,
    truncated: read.truncated,
  };
});
