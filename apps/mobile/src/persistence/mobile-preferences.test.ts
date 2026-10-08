import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

/** An in-memory storage boundary; the real preferences service encodes and sanitizes its data. */
function storage(initial: string | null = null) {
  let stored: MobileDatabase.StoredPreferencesJson | null = initial
    ? { payload: initial, updatedAt: 1 }
    : null;
  const database = MobileDatabase.MobileDatabase.of({
    loadCache: () => Effect.succeed(Option.none()),
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.sync(() => Option.fromNullishOr(stored)),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.sync(() => {
        stored = { payload, updatedAt };
      }),
  });
  const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  return MobilePreferences.make().pipe(
    Effect.provideService(MobileDatabase.MobileDatabase, database),
    Effect.provideService(MobileSecureStorage.MobileSecureStorage, secureStorage),
  );
}

describe("mobile automatic browser control preference", () => {
  it.effect("defaults to explicit control and survives persistence in both directions", () =>
    Effect.gen(function* () {
      const preferences = yield* storage();
      expect((yield* preferences.load).browserAutomaticControl ?? false).toBe(false);
      yield* preferences.savePatch({ browserAutomaticControl: true, baseFontSize: 18 });
      expect(yield* preferences.load).toMatchObject({
        browserAutomaticControl: true,
        baseFontSize: 18,
      });
      yield* preferences.savePatch({ browserAutomaticControl: false });
      expect(yield* preferences.load).toMatchObject({
        browserAutomaticControl: false,
        baseFontSize: 18,
      });
    }),
  );

  it.effect("ignores malformed persisted opt-ins", () =>
    Effect.gen(function* () {
      const preferences = yield* storage(JSON.stringify({ browserAutomaticControl: "true" }));
      expect((yield* preferences.load).browserAutomaticControl).toBeUndefined();
    }),
  );
});
