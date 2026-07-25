import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { DevShareError, shareDevServer } from "./dev-share.ts";

const TAILNET_STATUS = JSON.stringify({ Self: { DNSName: "host.example.ts.net." } });

/**
 * Answers `tailscale status --json` with a valid tailnet name, and lets each
 * test decide how the `serve` call behaves.
 */
const spawnerLayer = (serve: { readonly exitCode: number; readonly stderr?: string }) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = "args" in command ? (command.args as ReadonlyArray<string>) : [];
      const isStatus = args.includes("status");
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(isStatus ? 0 : serve.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: isStatus ? Stream.make(new TextEncoder().encode(TAILNET_STATUS)) : Stream.empty,
          stderr:
            !isStatus && serve.stderr
              ? Stream.make(new TextEncoder().encode(serve.stderr))
              : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

describe("shareDevServer", () => {
  it.effect("returns the tailnet URL for the same port", () =>
    Effect.gen(function* () {
      const shared = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(spawnerLayer({ exitCode: 0 })),
      );

      assert.equal(shared.host, "host.example.ts.net");
      assert.equal(shared.url, "https://host.example.ts.net:5788/");
    }),
  );

  // The stale-mapping clear runs before serve, so a failure here leaves the
  // port serving nothing. Saying only "serve failed" would let an operator
  // assume their previous mapping survived.
  it.effect("reports that the prior mapping was cleared when serve fails", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(spawnerLayer({ exitCode: 1, stderr: "port already in use" })),
        Effect.flip,
      );

      assert.equal(error.reason, "serve-failed");
      assert.include(error.message, "port already in use");
      assert.include(error.message, "no longer served");
      assert.include(error.message, "5788");
    }),
  );
});
