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
import * as NodeFS from "node:fs/promises";
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

  const fail = (message: string) =>
    Effect.fail(new OrchestrationGetWorkflowScriptError({ message }));

  if (!NodePath.isAbsolute(requested) || NodePath.extname(requested) !== ".js") {
    return yield* fail("Workflow scripts must be absolute .js paths.");
  }

  const root = yield* Effect.tryPromise({
    try: () => NodeFS.realpath(scriptsRoot()),
    catch: () => new OrchestrationGetWorkflowScriptError({ message: "Script root unavailable." }),
  });

  // Realpath the FILE itself (not just its directory): a symlink named
  // like a script inside a contained directory must not escape.
  const resolved = yield* Effect.tryPromise({
    try: () => NodeFS.realpath(requested),
    catch: () => new OrchestrationGetWorkflowScriptError({ message: "Script not found." }),
  });

  if (resolved !== root && !resolved.startsWith(`${root}${NodePath.sep}`)) {
    return yield* fail("Script path is outside the workflow scripts root.");
  }
  if (NodePath.extname(resolved) !== ".js") {
    return yield* fail("Resolved script is not a .js file.");
  }

  const stat = yield* Effect.tryPromise({
    try: () => NodeFS.stat(resolved),
    catch: () => new OrchestrationGetWorkflowScriptError({ message: "Script not readable." }),
  });
  if (!stat.isFile()) {
    return yield* fail("Script path is not a file.");
  }

  const handle = yield* Effect.tryPromise({
    try: () => NodeFS.open(resolved, "r"),
    catch: () => new OrchestrationGetWorkflowScriptError({ message: "Script not readable." }),
  });
  const truncated = stat.size > SCRIPT_BYTE_CAP;
  const buffer = Buffer.alloc(Math.min(stat.size, SCRIPT_BYTE_CAP));
  yield* Effect.tryPromise({
    try: async () => {
      try {
        await handle.read(buffer, 0, buffer.length, 0);
      } finally {
        await handle.close();
      }
    },
    catch: () => new OrchestrationGetWorkflowScriptError({ message: "Script read failed." }),
  });

  return {
    scriptPath: resolved,
    contents: buffer.toString("utf8"),
    truncated,
  };
});
