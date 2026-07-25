/**
 * Live {@link RequestCorrelator} implementation.
 *
 * Generic over the owner key (the route a request travels over) and the
 * response payload, so this is reusable by any provider with correlated
 * request/response framing — see the module docs on the service for why the
 * interrupt-safety and sweeping guarantees live here rather than at call sites.
 *
 * @module Layers/RequestCorrelator
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { RequestCorrelator, RequestCorrelatorSend } from "../Services/RequestCorrelator.ts";

interface PendingRequest<Owner, Response> {
  readonly owner: Owner;
  readonly method: string;
  readonly registeredAtMillis: number;
  readonly deferred: Deferred.Deferred<Response, ProviderAdapterRequestError>;
}

export interface MakeRequestCorrelatorOptions {
  /** Provider name stamped onto `ProviderAdapterRequestError`. */
  readonly provider: string;
  /** Default response timeout when a request does not override it. */
  readonly timeout: Duration.Duration;
  /**
   * Entries older than this are reaped by `sweep`. Comfortably larger than
   * `timeout` so the sweeper only ever catches entries whose own timeout
   * pipeline failed to run — a normal slow request is never stolen from
   * underneath its awaiting fiber.
   */
  readonly maxAge: Duration.Duration;
}

export const makeRequestCorrelator = <Owner, Response>(
  options: MakeRequestCorrelatorOptions,
): Effect.Effect<RequestCorrelator<Owner, Response>> =>
  Effect.gen(function* () {
    const pending = yield* Ref.make(new Map<string, PendingRequest<Owner, Response>>());

    const requestError = (method: string, detail: string) =>
      new ProviderAdapterRequestError({ provider: options.provider, method, detail });

    /** Remove one entry by id. Safe to call when it is already gone. */
    const release = (requestId: string) =>
      Ref.update(pending, (current) => {
        if (!current.has(requestId)) return current;
        const next = new Map(current);
        next.delete(requestId);
        return next;
      });

    const request = (input: RequestCorrelatorSend<Owner>) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<Response, ProviderAdapterRequestError>();
        const registeredAtMillis = yield* Clock.currentTimeMillis;

        // Registration and the send must not be interruptible independently of
        // the cleanup that removes the entry. `uninterruptibleMask` closes the
        // window: the registration is applied, `restore` re-enables interrupts
        // only inside the awaiting pipeline, and `ensuring` guarantees release
        // regardless of how that pipeline exits.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* Ref.update(pending, (current) =>
              new Map(current).set(input.requestId, {
                owner: input.owner,
                method: input.method,
                registeredAtMillis,
                deferred,
              }),
            );

            yield* input.send.pipe(Effect.tapError(() => release(input.requestId)));

            return yield* restore(Deferred.await(deferred)).pipe(
              Effect.timeout(input.timeout ?? options.timeout),
              Effect.mapError((error) =>
                error._tag === "TimeoutError"
                  ? requestError(input.method, `${options.provider} request timed out.`)
                  : error,
              ),
              Effect.ensuring(release(input.requestId)),
            );
          }),
        );
      });

    const complete = (requestId: string, response: Response) =>
      Ref.modify(pending, (current) => {
        const found = current.get(requestId);
        if (!found) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(requestId);
        return [found, next] as const;
      }).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.succeed(false)
            : Deferred.succeed(found.deferred, response).pipe(Effect.as(true)),
        ),
      );

    /**
     * Extract every entry matching `select`, then fail their deferreds. The
     * extraction is a single `Ref.modify` so two concurrent failures cannot
     * both claim the same entry.
     */
    const failMatching = (
      select: (entry: PendingRequest<Owner, Response>) => boolean,
      detail: (entry: PendingRequest<Owner, Response>) => string,
    ) =>
      Ref.modify(pending, (current) => {
        const claimed: Array<PendingRequest<Owner, Response>> = [];
        const next = new Map(current);
        for (const [requestId, entry] of current) {
          if (!select(entry)) continue;
          claimed.push(entry);
          next.delete(requestId);
        }
        return [claimed, next] as const;
      }).pipe(
        Effect.flatMap((claimed) =>
          Effect.forEach(
            claimed,
            (entry) => Deferred.fail(entry.deferred, requestError(entry.method, detail(entry))),
            { discard: true },
          ),
        ),
      );

    const failOwner = (owner: Owner, detail: string) =>
      failMatching(
        (entry) => entry.owner === owner,
        () => detail,
      );

    const sweep = Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        failMatching(
          (entry) => now - entry.registeredAtMillis >= Duration.toMillis(options.maxAge),
          () => `${options.provider} request was abandoned before it completed.`,
        ),
      ),
    );

    return {
      request,
      complete,
      failOwner,
      sweep,
      pendingCount: Ref.get(pending).pipe(Effect.map((current) => current.size)),
    } satisfies RequestCorrelator<Owner, Response>;
  });
