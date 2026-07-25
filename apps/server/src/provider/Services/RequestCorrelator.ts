/**
 * RequestCorrelator — generic request/response correlation over a one-way
 * message transport.
 *
 * Nothing in here is Hermes-specific. Any provider that speaks a protocol
 * where a request carries an id and the reply echoes it can use this: register
 * a pending entry, write the request, await the correlated reply, and have the
 * entry torn down on success, failure, timeout, or interrupt.
 *
 * The correlator owns three guarantees the call sites used to hand-roll:
 *
 *   1. **No interrupt window.** Registration happens uninterruptibly and the
 *      await pipeline is wrapped in `ensuring`, so there is no point at which
 *      an interrupt can leave an entry in the map with nobody to clean it up.
 *   2. **Age-based sweeping.** An entry whose awaiting fiber died abnormally
 *      is reaped by `sweep` instead of leaking for the process lifetime.
 *   3. **Owner-scoped failure.** When a connection drops, every request routed
 *      over it fails immediately rather than waiting out its timeout.
 *
 * @module RequestCorrelator
 */
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";

import type { ProviderAdapterRequestError } from "../Errors.ts";

export interface RequestCorrelatorSend<Owner> {
  /**
   * The logical route the request travels over. Used to fail an entire group
   * of in-flight requests at once when that route dies (see `failOwner`).
   */
  readonly owner: Owner;
  /** Correlation key. Must match the id echoed on the response. */
  readonly requestId: string;
  /** Protocol method name, surfaced on errors for diagnostics. */
  readonly method: string;
  /** Writes the request. Registration is already in place when this runs. */
  readonly send: Effect.Effect<void, ProviderAdapterRequestError>;
  /** Overrides the correlator's default response timeout. */
  readonly timeout?: Duration.Duration | undefined;
}

export interface RequestCorrelator<Owner, Response> {
  /**
   * Register, send, and await the correlated response. Cleans up the pending
   * entry on every exit path, including interrupt.
   */
  readonly request: (
    input: RequestCorrelatorSend<Owner>,
  ) => Effect.Effect<Response, ProviderAdapterRequestError>;

  /**
   * Resolve a pending request. Returns `false` when no entry was waiting,
   * which lets callers distinguish a correlated reply from an unsolicited one.
   */
  readonly complete: (requestId: string, response: Response) => Effect.Effect<boolean>;

  /** Fail every pending request registered against `owner`. */
  readonly failOwner: (owner: Owner, detail: string) => Effect.Effect<void>;

  /**
   * Fail pending entries older than the configured max age. Safety net for
   * entries whose awaiting fiber died without running its own cleanup.
   */
  readonly sweep: Effect.Effect<void>;

  /** Number of in-flight requests. Exposed for tests and diagnostics. */
  readonly pendingCount: Effect.Effect<number>;
}
