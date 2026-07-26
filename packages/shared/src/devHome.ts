/**
 * Where development state lives, and how to keep it away from the shared
 * `~/.t3` that a user's installed T3 Code runs against.
 *
 * A linked git worktree gets its own (gitignored) `.t3`: feature work in a
 * throwaway branch must not share a database with the real app, and an ambient
 * `T3CODE_HOME` counts as an *explicit* base dir — flipping the state directory
 * from `<base>/dev` to `<base>/userdata`, the live production database.
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * The path of the linked git worktree containing `cwd`, or undefined when
 * `cwd` is not inside one. Git marks a linked worktree by making `.git` a file
 * (`gitdir: …`) rather than a directory.
 *
 * Walks up to the repository root, so running from a subdirectory (`apps/web`,
 * say) resolves the same worktree as running from the top.
 */
export const resolveGitWorktreePath = (
  cwd: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    let directory = path.resolve(cwd);
    for (;;) {
      const info = yield* fileSystem.stat(path.join(directory, ".git")).pipe(Effect.option);
      if (Option.isSome(info)) {
        // A directory means the main checkout: not a linked worktree, and the
        // search stops either way — nesting one repo inside another does not
        // make the outer one this worktree's root.
        return info.value.type === "File" ? directory : undefined;
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  });

/**
 * The worktree-local data directory for `cwd`, or undefined outside a linked
 * worktree.
 *
 * Deliberately does not check whether the directory exists yet. Inside a
 * worktree this is *the* answer; falling back to the shared home because it
 * happens to be missing would send a tool at the user's real database, which
 * is the accident the worktree default exists to prevent. A caller that needs
 * a different directory should be told so explicitly (`--base-dir`).
 */
export const resolveWorktreeT3Home = (
  cwd: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveGitWorktreePath(cwd);
    if (worktreePath === undefined) {
      return undefined;
    }
    const path = yield* Path.Path;
    return path.join(worktreePath, ".t3");
  });
