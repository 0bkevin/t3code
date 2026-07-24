import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

const { openExternalMock, showItemInFolderMock, writeTextMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
    showItemInFolder: showItemInFolderMock,
  },
  clipboard: {
    writeText: writeTextMock,
  },
}));

import * as ElectronShell from "./ElectronShell.ts";

const testLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3code-electron-shell-test-",
    });
    return ElectronShell.layer({ temporaryDirectory });
  }),
).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));

describe("ElectronShell", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
    showItemInFolderMock.mockReset();
    writeTextMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("opens safe external URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not open unsafe external URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("file:///etc/passwd");

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns false when Electron rejects openExternal", () =>
    Effect.gen(function* () {
      openExternalMock.mockRejectedValue(new Error("open failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("downloads files with spaces and unicode names before revealing them", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("remote contents", { status: 200 })),
      );

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const electronShell = yield* ElectronShell.ElectronShell;
      const filePath = yield* electronShell.downloadAndReveal(
        "https://example.com/signed-asset",
        String.raw`C:\Users\TestUser\notes 😀 with spaces.txt`,
      );

      expect(path.basename(filePath)).toBe("notes 😀 with spaces.txt");
      expect(yield* fileSystem.readFileString(filePath)).toBe("remote contents");
      expect(showItemInFolderMock).toHaveBeenCalledExactlyOnceWith(filePath);
      yield* fileSystem.remove(path.dirname(filePath), { recursive: true, force: true });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects unsafe download URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* Effect.exit(
        electronShell.downloadAndReveal("file:///etc/passwd", "passwd"),
      );

      expect(result._tag).toBe("Failure");
      expect(showItemInFolderMock).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes only remote-file download directories older than three days", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-electron-shell-cleanup-test-",
      });
      const staleDirectory = path.join(temporaryDirectory, "t3code-remote-file-stale");
      const freshDirectory = path.join(temporaryDirectory, "t3code-remote-file-fresh");
      const unrelatedDirectory = path.join(temporaryDirectory, "other-app-stale");
      yield* Effect.forEach(
        [staleDirectory, freshDirectory, unrelatedDirectory],
        (directory) => fileSystem.makeDirectory(directory),
        { discard: true },
      );

      yield* TestClock.adjust(ElectronShell.REMOTE_FILE_RETENTION_MS * 2);
      const nowMillis = yield* Clock.currentTimeMillis;
      const staleTimestamp = nowMillis - ElectronShell.REMOTE_FILE_RETENTION_MS - 1;
      const freshTimestamp = nowMillis - ElectronShell.REMOTE_FILE_RETENTION_MS + 1_000;
      const staleDate = DateTime.toDateUtc(DateTime.makeUnsafe(staleTimestamp));
      const freshDate = DateTime.toDateUtc(DateTime.makeUnsafe(freshTimestamp));
      yield* fileSystem.utimes(staleDirectory, staleDate, staleDate);
      yield* fileSystem.utimes(freshDirectory, freshDate, freshDate);
      yield* fileSystem.utimes(unrelatedDirectory, staleDate, staleDate);

      yield* ElectronShell.cleanupStaleRemoteFileDownloads(temporaryDirectory, nowMillis);

      expect(yield* fileSystem.exists(staleDirectory)).toBe(false);
      expect(yield* fileSystem.exists(freshDirectory)).toBe(true);
      expect(yield* fileSystem.exists(unrelatedDirectory)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
