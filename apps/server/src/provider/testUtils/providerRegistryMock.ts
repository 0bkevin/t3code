import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import { ProviderDescribeError, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { describeFromServerProvider } from "../providerDescribe.ts";

/** Fixed so mock descriptions are deterministic across test runs. */
const MOCK_DESCRIBED_AT = "2024-01-01T00:00:00.000Z";

export const makeProviderRegistryMock = (
  providers: ReadonlyArray<ServerProvider> = [],
): ProviderRegistryShape => ({
  getProviders: Effect.succeed(providers),
  refresh: () => Effect.succeed(providers),
  refreshInstance: () => Effect.succeed(providers),
  describeInstance: (instanceId) => {
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    return provider
      ? Effect.succeed(describeFromServerProvider({ provider, describedAt: MOCK_DESCRIBED_AT }))
      : Effect.fail(
          new ProviderDescribeError({
            code: "instance-not-found",
            message: `Provider instance '${instanceId}' is not configured.`,
            instanceId,
          }),
        );
  },
  getSkillBody: ({ instanceId }) =>
    Effect.fail(
      new ProviderDescribeError({
        code: "unsupported",
        message: "This provider cannot read skill contents.",
        instanceId,
      }),
    ),
  getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
    Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null })),
  setProviderMaintenanceActionState: () => Effect.succeed(providers),
  streamChanges: Stream.empty,
});

export const makeProviderRegistryLayer = (providers: ReadonlyArray<ServerProvider> = []) =>
  Layer.succeed(ProviderRegistry, makeProviderRegistryMock(providers));
