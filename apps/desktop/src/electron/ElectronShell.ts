import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_FILE_DIRECTORY_PREFIX = "t3code-remote-file-";
export const REMOTE_FILE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

export function sanitizeDownloadFileName(rawFileName: string): string {
  const baseName = (rawFileName.split(/[\\/]/).pop() ?? "").trim();
  const sanitized = Array.from(baseName, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 || character === ":" ? "_" : character;
  }).join("");
  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    return "download";
  }
  return Array.from(sanitized).slice(0, 200).join("");
}

const ElectronShellDownloadOperation = Schema.Literals([
  "validate-url",
  "create-temp-directory",
  "download",
  "reveal",
]);

export class ElectronShellDownloadError extends Schema.TaggedErrorClass<ElectronShellDownloadError>()(
  "ElectronShellDownloadError",
  {
    operation: ElectronShellDownloadOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "validate-url":
        return "The download URL is invalid.";
      case "create-temp-directory":
        return "Unable to create a temporary download folder.";
      case "download":
        return "Unable to download the remote file.";
      case "reveal":
        return "The file was downloaded, but Finder could not reveal it.";
    }
  }
}

const isElectronShellDownloadError = Schema.is(ElectronShellDownloadError);

export const cleanupStaleRemoteFileDownloads = Effect.fn(
  "ElectronShell.cleanupStaleRemoteFileDownloads",
)(function* (temporaryDirectory: string, nowMillis: number) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem.readDirectory(temporaryDirectory);

  yield* Effect.forEach(
    entries,
    (entry) => {
      if (!entry.startsWith(REMOTE_FILE_DIRECTORY_PREFIX)) {
        return Effect.void;
      }
      const candidate = path.join(temporaryDirectory, entry);
      return fileSystem.stat(candidate).pipe(
        Effect.flatMap((info) => {
          if (info.type !== "Directory" || Option.isNone(info.mtime)) {
            return Effect.void;
          }
          const ageMillis = nowMillis - info.mtime.value.getTime();
          return ageMillis > REMOTE_FILE_RETENTION_MS
            ? fileSystem.remove(candidate, { recursive: true, force: true })
            : Effect.void;
        }),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to inspect or remove a stale remote-file download.", {
            candidate,
            cause,
          }),
        ),
      );
    },
    { concurrency: 4, discard: true },
  );
});

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly downloadAndReveal: (
      rawUrl: unknown,
      fileName: string,
    ) => Effect.Effect<string, ElectronShellDownloadError>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const layer = (options: { readonly temporaryDirectory: string }) =>
  Layer.effect(
    ElectronShell,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const nowMillis = yield* Clock.currentTimeMillis;

      yield* cleanupStaleRemoteFileDownloads(options.temporaryDirectory, nowMillis).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to clean stale remote-file downloads.", { cause }),
        ),
      );

      const downloadAndReveal = Effect.fn("ElectronShell.downloadAndReveal")(function* (
        rawUrl: unknown,
        rawFileName: string,
      ) {
        const url = Option.getOrElse(parseSafeExternalUrl(rawUrl), () => "");
        if (url === "") {
          return yield* new ElectronShellDownloadError({
            operation: "validate-url",
            cause: rawUrl,
          });
        }

        const directory = yield* fileSystem
          .makeTempDirectory({
            directory: options.temporaryDirectory,
            prefix: REMOTE_FILE_DIRECTORY_PREFIX,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ElectronShellDownloadError({
                  operation: "create-temp-directory",
                  cause,
                }),
            ),
          );
        const filePath = path.join(directory, sanitizeDownloadFileName(rawFileName));

        return yield* Effect.gen(function* () {
          const response = yield* httpClient.get(url);
          yield* Stream.run(response.stream, fileSystem.sink(filePath, { flag: "wx" }));
          yield* Effect.try({
            try: () => Electron.shell.showItemInFolder(filePath),
            catch: (cause) =>
              new ElectronShellDownloadError({
                operation: "reveal",
                cause,
              }),
          });
          return filePath;
        }).pipe(
          Effect.mapError((cause) =>
            isElectronShellDownloadError(cause)
              ? cause
              : new ElectronShellDownloadError({
                  operation: "download",
                  cause,
                }),
          ),
          Effect.tapError(() =>
            fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
        );
      });

      return ElectronShell.of({
        openExternal: (rawUrl) =>
          Option.match(parseSafeExternalUrl(rawUrl), {
            onNone: () => Effect.succeed(false),
            onSome: (externalUrl) =>
              Effect.promise(() =>
                Electron.shell.openExternal(externalUrl).then(
                  () => true,
                  () => false,
                ),
              ),
          }),
        downloadAndReveal,
        copyText: (text) =>
          Effect.sync(() => {
            Electron.clipboard.writeText(text);
          }),
      });
    }),
  );
