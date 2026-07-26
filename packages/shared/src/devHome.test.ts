// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { resolveGitWorktreePath, resolveWorktreeT3Home } from "./devHome.ts";

/**
 * Git marks a linked worktree with a `.git` *file*; a main checkout has a
 * `.git` directory. Both are built for real so the distinction is exercised
 * rather than mocked. Torn down by the scope, after the effect has run.
 */
const makeRepo = (kind: "worktree" | "checkout" | "bare") =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devhome-"));
      if (kind === "worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      } else if (kind === "checkout") {
        NodeFS.mkdirSync(NodePath.join(root, ".git"));
      }
      const nested = NodePath.join(root, "apps", "web", "src");
      NodeFS.mkdirSync(nested, { recursive: true });
      return { root, nested };
    }),
    ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

describe("resolveGitWorktreePath", () => {
  it.effect("finds the worktree root from the top", () =>
    Effect.gen(function* () {
      const { root } = yield* makeRepo("worktree");
      assert.equal(yield* resolveGitWorktreePath(root), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Running `dev:pair` from apps/web must resolve the same worktree as from the
  // repo root; otherwise it falls through to the shared home.
  it.effect("finds the worktree root from a subdirectory", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a main checkout as not a worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("checkout");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a directory outside any repository", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("bare");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("resolveWorktreeT3Home", () => {
  // Deliberately does not require the directory to exist: answering "undefined"
  // would send callers at the user's real database.
  it.effect("answers with .t3 even before the dev runner creates it", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      const home = yield* resolveWorktreeT3Home(nested);
      assert.equal(home, NodePath.join(NodePath.resolve(root), ".t3"));
      assert.isFalse(NodeFS.existsSync(home ?? ""));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a main checkout on the shared home", () =>
    Effect.gen(function* () {
      const { root } = yield* makeRepo("checkout");
      assert.equal(yield* resolveWorktreeT3Home(root), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
