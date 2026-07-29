import {
  ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  removeCatalogValue,
  replaceCatalogValue,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  type ConnectionAttemptError,
  CredentialStore,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as CatalogStore from "./catalog-store";
import * as RemoteDpopTokenStore from "./token-store";

function targetPersistenceError(
  operation: "list-targets" | "register-connection" | "remove-connection",
  error: ConnectionAttemptError,
) {
  return new ConnectionPersistenceError({
    operation,
    message: error.message,
  });
}

export const connectionStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* CatalogStore.make();
    // Tokens live outside the catalog document so reconnecting environments
    // do not serialize on the catalog lock. See token-store.ts.
    const remoteTokenStore = yield* RemoteDpopTokenStore.make(catalog);

    const targetStore = ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError((error) => targetPersistenceError("list-targets", error)),
      ),
    });
    const registrationStore = ConnectionRegistrationStore.of({
      register: (registration) =>
        catalog
          .update((document) => registerConnectionInCatalog(document, registration))
          .pipe(Effect.mapError((error) => targetPersistenceError("register-connection", error))),
      // The token key is deleted before the catalog entry: if the keychain
      // delete fails the registration survives and the removal can be retried,
      // instead of leaving an orphaned token that a re-added environment
      // would pick back up.
      remove: (target) =>
        remoteTokenStore.remove(target.environmentId).pipe(
          Effect.andThen(
            catalog.update((document) => removeConnectionFromCatalog(document, target)),
          ),
          Effect.mapError((error) => targetPersistenceError("remove-connection", error)),
        ),
    });
    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.profiles.find((candidate) => candidate.connectionId === connectionId),
            ),
          ),
        ),
      put: (profile) =>
        catalog.update((document) => ({
          ...document,
          profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, profile),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
            ),
          ),
        ),
      put: (connectionId, credential) =>
        catalog.update((document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    return Context.make(ConnectionTargetStore, targetStore).pipe(
      Context.add(ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
    );
  }),
);
