// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import type * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// Node does not expose Darwin's all-components no-follow flag.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

function errnoCode(cause: unknown): string | undefined {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
}

async function openLinuxPath(
  absolutePath: string,
  flags: number,
  mode?: number,
): Promise<NodeFSP.FileHandle> {
  const segments = absolutePath.split(NodePath.sep).filter(Boolean);
  const fileName = segments.pop();
  if (!fileName || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Cannot safely open non-canonical path: ${absolutePath}`);
  }

  let directory = await NodeFS.promises.open(
    NodePath.sep,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY,
  );
  try {
    for (const segment of segments) {
      // Each lookup is anchored to an already-open directory, so replacing its
      // original pathname cannot redirect any later component.
      const nextDirectory = await NodeFS.promises.open(
        `/proc/self/fd/${directory.fd}/${segment}`,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
      );
      await directory.close();
      directory = nextDirectory;
    }

    return await NodeFS.promises.open(
      `/proc/self/fd/${directory.fd}/${fileName}`,
      flags | NodeFS.constants.O_NOFOLLOW,
      mode,
    );
  } finally {
    await directory.close();
  }
}

async function verifyFallbackHandle(
  absolutePath: string,
  handle: NodeFSP.FileHandle,
): Promise<NodeFSP.FileHandle> {
  try {
    const [canonicalPath, pathInfo, handleInfo] = await Promise.all([
      NodeFS.promises.realpath(absolutePath),
      NodeFS.promises.stat(absolutePath),
      handle.stat(),
    ]);
    if (
      canonicalPath !== absolutePath ||
      pathInfo.dev !== handleInfo.dev ||
      pathInfo.ino !== handleInfo.ino
    ) {
      throw new Error(`Path changed while it was being opened: ${absolutePath}`);
    }
    return handle;
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

async function openPathNoFollow(
  absolutePath: string,
  flags: number,
  platform: NodeJS.Platform,
  mode?: number,
): Promise<NodeFSP.FileHandle> {
  if (!NodePath.isAbsolute(absolutePath) || NodePath.resolve(absolutePath) !== absolutePath) {
    throw new Error(`Cannot safely open non-canonical path: ${absolutePath}`);
  }

  if (platform === "darwin") {
    return NodeFS.promises.open(absolutePath, flags | DARWIN_O_NOFOLLOW_ANY, mode);
  }
  if (platform === "linux") {
    return openLinuxPath(absolutePath, flags, mode);
  }

  // Other platforms lack an openat-style primitive in Node. Keep the handle
  // only when its identity still matches the canonical pathname.
  const noFollow = NodeFS.constants.O_NOFOLLOW ?? 0;
  const handle = await NodeFS.promises.open(absolutePath, flags | noFollow, mode);
  return verifyFallbackHandle(absolutePath, handle);
}

export async function openReadableFileNoFollow(
  absolutePath: string,
  platform: NodeJS.Platform,
): Promise<{
  readonly stream: NodeFS.ReadStream;
  readonly size: number;
}> {
  const handle = await openPathNoFollow(absolutePath, NodeFS.constants.O_RDONLY, platform);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`Expected a regular file: ${absolutePath}`);
    }
    return {
      stream: handle.createReadStream({ autoClose: true }),
      size: info.size,
    };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

export async function openWritableFileNoFollow(
  absolutePath: string,
  platform: NodeJS.Platform,
): Promise<NodeFSP.FileHandle> {
  try {
    return await openPathNoFollow(absolutePath, NodeFS.constants.O_WRONLY, platform);
  } catch (cause) {
    if (errnoCode(cause) !== "ENOENT") {
      throw cause;
    }
    return openPathNoFollow(
      absolutePath,
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
      platform,
      0o666,
    );
  }
}
