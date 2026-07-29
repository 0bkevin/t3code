import { TokenStore } from "@t3tools/client-runtime/authorization";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MobileSecureStorage from "../persistence/mobile-secure-storage";
import type { CatalogStore } from "./catalog-store";

export const REMOTE_DPOP_TOKEN_KEY_PREFIX = "t3code.remote-dpop-token.";

const RemoteDpopAccessTokenJson = Schema.fromJsonString(TokenStore.RemoteDpopAccessToken);
const decodeRemoteDpopAccessToken = Schema.decodeEffect(RemoteDpopAccessTokenJson);
const encodeRemoteDpopAccessToken = Schema.encodeEffect(RemoteDpopAccessTokenJson);

function tokenError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the environment access token: ${String(cause)}`,
  });
}

// SecureStore only accepts [A-Za-z0-9._-] keys and the EnvironmentId schema
// allows free-form strings, so the id is base64url-encoded: collision-free,
// unlike lossy character replacement, which would let two ids share a key and
// silently clobber each other's tokens.
function tokenKey(environmentId: EnvironmentId): string {
  return REMOTE_DPOP_TOKEN_KEY_PREFIX + Encoding.encodeBase64Url(environmentId);
}

/**
 * Remote DPoP access tokens used to live inside the connection catalog
 * document, which put every token read and write behind one semaphore and
 * re-encoded the whole catalog into a Keychain item on each update. With
 * several environments reconnecting at once that serialized the parallel
 * supervisor fan-out into O(N) full-document Keychain writes.
 *
 * Each token now lives under its own SecureStore key with a write-through
 * in-memory cache, so per-environment token operations are independent.
 * Tokens still found in the catalog document are migrated to their own key
 * the first time the environment asks for them.
 */
export const make = Effect.fn("mobile.remoteDpopTokenStore.make")(function* (
  catalog: CatalogStore,
) {
  const storage = yield* MobileSecureStorage.MobileSecureStorage;
  const cache = yield* Ref.make(new Map<EnvironmentId, TokenStore.RemoteDpopAccessToken>());

  // Operations on the same environment serialize so an in-flight `get` cannot
  // republish a token that a concurrent `remove` or `put` just replaced.
  // Different environments never share a lock; that independence is the point
  // of this store.
  const locks = new Map<EnvironmentId, Semaphore.Semaphore>();
  const withEnvironmentLock = (environmentId: EnvironmentId) => {
    let lock = locks.get(environmentId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(environmentId, lock);
    }
    return lock.withPermits(1);
  };

  const cachePut = (token: TokenStore.RemoteDpopAccessToken) =>
    Ref.update(cache, (entries) => new Map(entries).set(token.environmentId, token));
  const cacheRemove = (environmentId: EnvironmentId) =>
    Ref.update(cache, (entries) => {
      const next = new Map(entries);
      next.delete(environmentId);
      return next;
    });

  const writeToken = Effect.fn("mobile.remoteDpopTokenStore.writeToken")(function* (
    token: TokenStore.RemoteDpopAccessToken,
  ) {
    const encoded = yield* encodeRemoteDpopAccessToken(token).pipe(
      Effect.mapError((cause) => tokenError("encode", cause)),
    );
    yield* storage
      .setItem(tokenKey(token.environmentId), encoded)
      .pipe(Effect.mapError((cause) => tokenError("save", cause)));
    yield* cachePut(token);
  });

  // One-time move of a token stored in the catalog document (the pre-split
  // layout) to its own key. Clearing the document entry costs one full-catalog
  // write, but only for environments persisted before the split.
  const migrateLegacyToken = Effect.fn("mobile.remoteDpopTokenStore.migrateLegacyToken")(function* (
    environmentId: EnvironmentId,
  ) {
    const document = yield* catalog.read;
    const legacy = document.remoteDpopTokens.find((token) => token.environmentId === environmentId);
    if (legacy === undefined) {
      return Option.none<TokenStore.RemoteDpopAccessToken>();
    }
    yield* writeToken(legacy);
    // The standalone key is now authoritative, so a failed catalog cleanup
    // must not fail the read; the leftover duplicate is purged on removal.
    yield* catalog
      .update((current) => ({
        ...current,
        remoteDpopTokens: current.remoteDpopTokens.filter(
          (token) => token.environmentId !== environmentId,
        ),
      }))
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not clear a migrated environment access token", error),
        ),
      );
    return Option.some(legacy);
  });

  const getLocked = Effect.fn("mobile.remoteDpopTokenStore.get")(function* (
    environmentId: EnvironmentId,
  ) {
    const cached = (yield* Ref.get(cache)).get(environmentId);
    if (cached !== undefined) {
      return Option.some(cached);
    }
    const raw = yield* storage
      .getItem(tokenKey(environmentId))
      .pipe(Effect.mapError((cause) => tokenError("load", cause)));
    if (raw === null) {
      return yield* migrateLegacyToken(environmentId);
    }
    const decoded = yield* decodeRemoteDpopAccessToken(raw).pipe(
      Effect.mapError((cause) => tokenError("decode", cause)),
      Effect.catch((error) =>
        Effect.logWarning("Discarding corrupt persisted environment access token", error).pipe(
          Effect.andThen(
            storage
              .removeItem(tokenKey(environmentId))
              .pipe(Effect.mapError((cause) => tokenError("delete", cause))),
          ),
          Effect.as(null),
        ),
      ),
    );
    if (decoded === null || decoded.environmentId !== environmentId) {
      return Option.none<TokenStore.RemoteDpopAccessToken>();
    }
    yield* cachePut(decoded);
    return Option.some(decoded);
  });

  const removeLocked = Effect.fn("mobile.remoteDpopTokenStore.remove")(function* (
    environmentId: EnvironmentId,
  ) {
    yield* cacheRemove(environmentId);
    yield* storage
      .removeItem(tokenKey(environmentId))
      .pipe(Effect.mapError((cause) => tokenError("delete", cause)));
    // Also drop any pre-split copy so it cannot resurface through migration.
    const document = yield* catalog.read;
    if (document.remoteDpopTokens.some((token) => token.environmentId === environmentId)) {
      yield* catalog.update((current) => ({
        ...current,
        remoteDpopTokens: current.remoteDpopTokens.filter(
          (token) => token.environmentId !== environmentId,
        ),
      }));
    }
  });

  return TokenStore.make({
    get: (environmentId) => withEnvironmentLock(environmentId)(getLocked(environmentId)),
    put: (token) => withEnvironmentLock(token.environmentId)(writeToken(token)),
    remove: (environmentId) => withEnvironmentLock(environmentId)(removeLocked(environmentId)),
  });
});
