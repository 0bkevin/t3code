import { TokenStore } from "@t3tools/client-runtime/authorization";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import * as CatalogStore from "./catalog-store";
import { REMOTE_DPOP_TOKEN_KEY_PREFIX, make } from "./token-store";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

const TOKEN = new TokenStore.RemoteDpopAccessToken({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  endpoint: {
    httpBaseUrl: "https://remote.example.test",
    wsBaseUrl: "wss://remote.example.test",
    providerKind: "cloudflare_tunnel",
  },
  accessToken: "dpop-token",
  expiresAtEpochMs: 1_000_000,
  dpopThumbprint: "thumbprint",
});

const TOKEN_KEY = `${REMOTE_DPOP_TOKEN_KEY_PREFIX}${Encoding.encodeBase64Url(ENVIRONMENT_ID)}`;

const encodeToken = Schema.encodeSync(TokenStore.RemoteDpopAccessToken);

function makeStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: Array<string> = [];
  const storage = MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        writes.push(key);
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  });
  return { storage, values, writes };
}

const makeStores = Effect.fn("makeStores")(function* (storage: MobileSecureStorage["Service"]) {
  const catalog = yield* CatalogStore.make().pipe(
    Effect.provideService(MobileSecureStorage, storage),
  );
  const tokens = yield* make(catalog).pipe(Effect.provideService(MobileSecureStorage, storage));
  return { catalog, tokens };
});

describe("mobile remote DPoP token store", () => {
  it.effect("stores each token under its own key without touching the catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage();
      const { catalog, tokens } = yield* makeStores(memory.storage);

      yield* tokens.put(TOKEN);
      expect(memory.values.has(TOKEN_KEY)).toBe(true);
      expect((yield* catalog.read).remoteDpopTokens).toEqual([]);

      const loaded = yield* tokens.get(ENVIRONMENT_ID);
      expect(Option.getOrThrow(loaded)).toMatchObject({ accessToken: "dpop-token" });

      yield* tokens.remove(ENVIRONMENT_ID);
      expect(memory.values.has(TOKEN_KEY)).toBe(false);
      expect(Option.isNone(yield* tokens.get(ENVIRONMENT_ID))).toBe(true);
    }),
  );

  it.effect("serves repeat reads from memory without re-reading the keychain", () =>
    Effect.gen(function* () {
      const memory = makeStorage();
      const { tokens } = yield* makeStores(memory.storage);

      yield* tokens.put(TOKEN);
      // Corrupt the persisted copy: a cached read must not notice.
      memory.values.set(TOKEN_KEY, "{not-json");
      const loaded = yield* tokens.get(ENVIRONMENT_ID);
      expect(Option.getOrThrow(loaded).accessToken).toBe("dpop-token");
    }),
  );

  it.effect("migrates a token persisted inside the catalog document to its own key", () =>
    Effect.gen(function* () {
      const memory = makeStorage();
      const { catalog, tokens } = yield* makeStores(memory.storage);
      yield* catalog.update((document) => ({
        ...document,
        remoteDpopTokens: [TOKEN],
      }));

      const loaded = yield* tokens.get(ENVIRONMENT_ID);
      expect(Option.getOrThrow(loaded)).toMatchObject({ accessToken: "dpop-token" });
      expect(memory.values.has(TOKEN_KEY)).toBe(true);
      expect((yield* catalog.read).remoteDpopTokens).toEqual([]);
    }),
  );

  it.effect("does not resurrect a token removed while a cold read is in flight", () =>
    Effect.gen(function* () {
      const readGate = yield* Deferred.make<void>();
      const readStarted = yield* Deferred.make<void>();
      const memory = makeStorage();
      // getItem captures the stored value immediately (like a real Keychain
      // read that already completed) but only delivers it after the gate, so
      // the remove can run while the read is in flight.
      const gatedStorage = MobileSecureStorage.of({
        getItem: (key) =>
          key === TOKEN_KEY
            ? Effect.sync(() => memory.values.get(key) ?? null).pipe(
                Effect.tap(() => Deferred.succeed(readStarted, undefined)),
                Effect.tap(() => Deferred.await(readGate)),
              )
            : Effect.sync(() => memory.values.get(key) ?? null),
        setItem: (key, value) =>
          Effect.sync(() => {
            memory.values.set(key, value);
          }),
        removeItem: (key) =>
          Effect.sync(() => {
            memory.values.delete(key);
          }),
      });
      const { tokens } = yield* makeStores(gatedStorage);
      yield* Effect.sync(() => memory.values.set(TOKEN_KEY, JSON.stringify(encodeToken(TOKEN))));

      const pendingGet = yield* tokens.get(ENVIRONMENT_ID).pipe(Effect.forkScoped);
      yield* Deferred.await(readStarted);
      const pendingRemove = yield* tokens.remove(ENVIRONMENT_ID).pipe(Effect.forkScoped);
      // Give remove every chance to run while the read is parked on the gate.
      // With per-environment serialization it stays queued behind the get; a
      // regression lets it delete the keychain entry here, and the resumed
      // get would then resurrect the removed token into the cache.
      for (let i = 0; i < 20 && memory.values.has(TOKEN_KEY); i += 1) {
        yield* Effect.yieldNow;
      }
      yield* Deferred.succeed(readGate, undefined);
      yield* Fiber.join(pendingGet);
      yield* Fiber.join(pendingRemove);

      // remove ran after get completed (same-env operations serialize), so
      // the token is gone from both the keychain and the in-memory cache.
      expect(memory.values.has(TOKEN_KEY)).toBe(false);
      expect(Option.isNone(yield* tokens.get(ENVIRONMENT_ID))).toBe(true);
    }),
  );

  it.effect("discards a corrupt persisted token instead of failing the connection", () =>
    Effect.gen(function* () {
      const memory = makeStorage({ [TOKEN_KEY]: "{not-json" });
      const { tokens } = yield* makeStores(memory.storage);

      expect(Option.isNone(yield* tokens.get(ENVIRONMENT_ID))).toBe(true);
      expect(memory.values.has(TOKEN_KEY)).toBe(false);
    }),
  );
});
