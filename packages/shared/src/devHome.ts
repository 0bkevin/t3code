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
 * The path of the linked git worktree containing `cwd`'s root, or undefined
 * for a main checkout. Git marks a linked worktree by making `.git` a file
 * (`gitdir: …`) rather than a directory.
 */
export const resolveGitWorktreePath = (
  cwd: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const info = yield* fileSystem.stat(path.join(cwd, ".git")).pipe(Effect.option);
    return Option.isSome(info) && info.value.type === "File" ? cwd : undefined;
  });

/**
 * The worktree-local data directory for `cwd`, or undefined outside a linked
 * worktree. With `requireExisting`, also undefined until something (normally
 * the dev runner) has created it — for tools that should fall back to normal
 * resolution rather than inventing an empty data directory.
 */
export const resolveWorktreeT3Home = (
  cwd: string,
  options?: { readonly requireExisting?: boolean },
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveGitWorktreePath(cwd);
    if (worktreePath === undefined) {
      return undefined;
    }
    const path = yield* Path.Path;
    const home = path.join(worktreePath, ".t3");
    if (options?.requireExisting) {
      const fileSystem = yield* FileSystem.FileSystem;
      const exists = yield* fileSystem.exists(home).pipe(Effect.orElseSucceed(() => false));
      return exists ? home : undefined;
    }
    return home;
  });
