/**
 * Shares a running dev server on the local tailnet via `tailscale serve`, so it
 * can be opened from a phone, another laptop, or by whoever is reviewing the
 * work.
 *
 * Thin wrapper over `@t3tools/tailscale` (the same client the server's own
 * `--tailscale-serve` uses). What it adds is dev-share semantics: replacing a
 * stale mapping left by a killed run, and refusing to serve over routes it
 * could not remove.
 *
 * Because browser dev is single-origin (Vite proxies the backend — see
 * `resolveDevProxyTarget` in apps/web/vite.config.ts), one proxy rule covering
 * the web port is enough; the backend needs no mapping of its own.
 */

import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleStatus,
  type TailscaleCommandError,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process";

export class DevShareError extends Schema.TaggedErrorClass<DevShareError>()("DevShareError", {
  reason: Schema.Literals(["tailscale-unavailable", "no-tailnet-name", "serve-failed"]),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const base = {
      "tailscale-unavailable": "could not talk to tailscale",
      "no-tailnet-name": "this machine has no tailnet DNS name",
      "serve-failed": "tailscale serve failed",
    }[this.reason];
    return this.detail ? `${base}: ${this.detail}` : base;
  }

  /** What the user can actually do about it. */
  get hint(): string | undefined {
    return {
      "tailscale-unavailable":
        "Is Tailscale installed and tailscaled running? Try `tailscale status` — or drop --share and open the printed localhost URL.",
      "no-tailnet-name": "Run `tailscale up` and make sure MagicDNS is enabled.",
      "serve-failed": undefined,
    }[this.reason];
  }
}

const commandDetail = (error: TailscaleCommandError): string =>
  error._tag === "TailscaleCommandExitError" && error.stderrPreview !== undefined
    ? `${error.message} ${error.stderrPreview}`
    : error.message;

/**
 * `tailscale serve … off` exits nonzero with this when the port had no mapping,
 * which is the normal case for a first-time share — not a failure.
 */
const NO_EXISTING_HANDLER_PATTERN = /handler does not exist/i;

/**
 * Removes any mapping for `webPort`, reporting whether the port is now clear.
 *
 * Runs uninterruptibly: this is called from a finalizer on the way out of an
 * interrupted program, and cancelling the cleanup subprocess would leave
 * exactly the stale mapping it exists to remove.
 */
export const unshareDevServer = (
  webPort: number,
): Effect.Effect<
  { readonly cleared: boolean; readonly detail?: string | undefined },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  disableTailscaleServe({ servePort: webPort }).pipe(
    Effect.as({ cleared: true } as const),
    Effect.catch((error: TailscaleCommandError) =>
      Effect.succeed(
        // "Nothing was mapped" leaves the port clear either way.
        error._tag === "TailscaleCommandExitError" &&
          NO_EXISTING_HANDLER_PATTERN.test(error.stderrPreview ?? "")
          ? ({ cleared: true } as const)
          : ({ cleared: false, detail: commandDetail(error) } as const),
      ),
    ),
    Effect.uninterruptible,
  );

export interface DevShareResult {
  readonly url: string;
  readonly host: string;
}

/**
 * Publishes `webPort` on the tailnet at the same port number and returns the
 * resulting HTTPS URL. Idempotent: re-running replaces any existing mapping.
 */
export const shareDevServer = Effect.fn("devShare.shareDevServer")(function* (input: {
  readonly webPort: number;
}) {
  const status = yield* readTailscaleStatus.pipe(
    Effect.mapError(
      (error) => new DevShareError({ reason: "tailscale-unavailable", detail: error.message }),
    ),
  );
  if (status.magicDnsName === null) {
    return yield* new DevShareError({ reason: "no-tailnet-name" });
  }

  // Clear any mapping left behind by a run that was killed before its finalizer
  // could fire. Serve config survives both the process and a reboot, and a
  // stale entry may carry path routes we no longer want — older versions mapped
  // /ws, /api and friends to a separate backend port, and serving "/" alone
  // would leave those pointing at a port nothing is listening on.
  const cleared = yield* unshareDevServer(input.webPort);
  if (!cleared.cleared) {
    // Serving over routes we failed to remove would hand out a URL that is
    // broken in a way the user cannot see: the page loads while /ws and /api
    // silently resolve to a dead backend. Better to refuse and say why.
    return yield* new DevShareError({
      reason: "serve-failed",
      detail: `could not clear the existing mapping for port ${String(input.webPort)}${
        cleared.detail ? `: ${cleared.detail}` : ""
      }. Run \`tailscale serve --https=${String(input.webPort)} off\` and retry.`,
    });
  }

  yield* ensureTailscaleServe({ localPort: input.webPort, servePort: input.webPort }).pipe(
    Effect.mapError(
      (error) =>
        new DevShareError({
          reason: "serve-failed",
          detail: `${commandDetail(error)} (port ${String(input.webPort)} is no longer served; any previous mapping for it was cleared before this attempt)`,
        }),
    ),
  );

  return {
    url: buildTailscaleHttpsBaseUrl({
      magicDnsName: status.magicDnsName,
      servePort: input.webPort,
    }),
    host: status.magicDnsName,
  } satisfies DevShareResult;
});
