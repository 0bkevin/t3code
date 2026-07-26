import {
  DEFAULT_HERMES_MODEL,
  HERMES_DRIVER_KIND,
  HermesSettings,
  TextGenerationError,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { readHomeThreadId } from "../../orchestration/homeThreads.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { HermesGatewayBroker } from "../Services/HermesGatewayBroker.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

export type HermesDriverEnv = Crypto.Crypto | ServerSettingsService;

const unsupportedTextGeneration = (
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle",
) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Hermes gateway instances do not support utility text generation.",
    }),
  );

const makeTextGeneration = (): TextGenerationShape => ({
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
});

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: HERMES_DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: () => decodeHermesSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled }) =>
    Effect.gen(function* () {
      const broker = yield* HermesGatewayBroker;
      // Captured once at construction: `getSnapshot` must be context-free
      // (`R = never`) because the registry calls it outside this scope.
      const settings = yield* ServerSettingsService;
      const adapter = yield* makeHermesAdapter({ instanceId });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: HERMES_DRIVER_KIND,
        instanceId,
      });
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: HERMES_DRIVER_KIND,
        packageName: null,
      });
      const getSnapshot = Effect.gen(function* () {
        const connected = yield* broker.isConnected(instanceId);
        const status = yield* broker
          .getInstanceStatus(instanceId)
          .pipe(Effect.catchTag("HermesGatewayManagementError", () => Effect.succeed(undefined)));
        // Read-only: a snapshot must never create the thread as a side effect
        // (this runs on every status tick). The handshake owns creation.
        // A settings read that fails degrades to "no designation" rather than
        // failing the whole snapshot — the pin is cosmetic, the status is not.
        const currentSettings = yield* settings.getSettings.pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<ServerSettings>()),
        );
        const homeThreadId = Option.isSome(currentSettings)
          ? readHomeThreadId(currentSettings.value.providerInstances[instanceId])
          : undefined;
        return {
          ...(homeThreadId !== undefined ? { homeThreadId } : {}),
          instanceId,
          driver: HERMES_DRIVER_KIND,
          ...(displayName ? { displayName } : {}),
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          showInteractionModeToggle: false,
          requiresNewThreadForModelChange: true,
          requiresWorkspace: false,
          enabled,
          installed: true,
          version: status?.hermesVersion ?? null,
          status: !enabled ? "disabled" : connected ? "ready" : "warning",
          auth: {
            status: connected ? "authenticated" : "unauthenticated",
            type: "gateway",
            label: status?.nickname ?? displayName ?? "Hermes",
          },
          checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          ...(!connected && enabled
            ? { message: "Hermes is offline. Reconnect its T3 Code gateway plugin." }
            : {}),
          availability: "available",
          // The slug stays `DEFAULT_HERMES_MODEL` no matter what the plugin
          // reports: threads bind to it, and letting it follow Hermes' current
          // config would orphan every thread whose model changed on the Hermes
          // side. The reported model is used only as the human-facing name, so
          // the picker says "gpt-5.6-terra" instead of a generic placeholder.
          // Falls back to "Hermes" when no plugin has connected yet or the
          // plugin predates the `model` field on `connection.hello`.
          models: [
            {
              slug: DEFAULT_HERMES_MODEL,
              name: status?.model ?? "Hermes",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });
      const snapshot = {
        maintenanceCapabilities,
        getSnapshot,
        refresh: getSnapshot,
        streamChanges: broker.streamStatuses.pipe(
          Stream.filter((status) => status.instanceId === instanceId),
          Stream.mapEffect(() => getSnapshot),
        ),
      };

      return {
        instanceId,
        driverKind: HERMES_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
