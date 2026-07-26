/**
 * Provider-generic instance description.
 *
 * Backs the Agent page (`/agents/$instanceId`). The default projection here
 * derives everything from the `ServerProvider` snapshot every driver already
 * publishes, so Claude, Codex, Cursor, Grok, and OpenCode get a populated page
 * without any driver work. Drivers that can answer more precisely — Hermes,
 * which can ask its connected plugin — layer their own data on top via
 * `ProviderAdapterShape.describe`.
 *
 * Kept as pure functions over snapshots (no Effect, no services) so the
 * projection is directly testable and so `ws.ts` stays a thin transport.
 *
 * @module provider/providerDescribe
 */
import type {
  ProviderInstanceConnection,
  ProviderInstanceDescription,
  ProviderInstanceModelInfo,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";

/**
 * Option-descriptor ids that mean "reasoning effort" across drivers.
 *
 * Effort is not first-class anywhere in the contracts: each driver declares it
 * as a `ProviderOptionDescriptor` under its own id (`reasoningEffort` on Codex,
 * `reasoning` on Cursor, `effort` on some forks). Matching on a small known set
 * — plus a normalized-substring fallback — is what lets the Agent page show one
 * "Reasoning effort" row without teaching the client each driver's vocabulary.
 *
 * A driver whose descriptor matches nothing here reports `null`, and the page
 * renders "not reported" rather than guessing at an unrelated option.
 */
const REASONING_EFFORT_OPTION_IDS: ReadonlyArray<string> = [
  "reasoningEffort",
  "reasoning_effort",
  "reasoning",
  "effort",
  "thinking",
  "thinkingLevel",
];

const normalizeOptionId = (id: string): string => id.toLowerCase().replaceAll(/[^a-z]/g, "");

const NORMALIZED_REASONING_EFFORT_IDS = new Set(REASONING_EFFORT_OPTION_IDS.map(normalizeOptionId));

/**
 * Pick the model the snapshot considers current.
 *
 * `isDefault` is the only "which one is live" marker on the snapshot; when no
 * model carries it we fall back to the first, which is the order drivers
 * publish their preferred model in. Returns `undefined` for an empty list
 * rather than fabricating a model row.
 */
export function resolveCurrentSnapshotModel(
  models: ReadonlyArray<ServerProviderModel>,
): ServerProviderModel | undefined {
  return models.find((model) => model.isDefault === true) ?? models[0];
}

/**
 * Resolve reasoning effort to a human label, or `null` when this driver does
 * not expose one. Never returns a raw option id — see
 * `ProviderInstanceModelInfo.reasoningEffortLabel`.
 */
export function resolveReasoningEffortLabel(model: ServerProviderModel | undefined): string | null {
  const descriptors = model?.capabilities?.optionDescriptors;
  if (!descriptors || descriptors.length === 0) {
    return null;
  }
  const descriptor =
    descriptors.find((candidate) => REASONING_EFFORT_OPTION_IDS.includes(candidate.id)) ??
    descriptors.find((candidate) =>
      NORMALIZED_REASONING_EFFORT_IDS.has(normalizeOptionId(candidate.id)),
    );
  if (!descriptor) {
    return null;
  }
  return getProviderOptionCurrentLabel(descriptor) ?? null;
}

/**
 * Map the snapshot's `status` onto the description's connection vocabulary.
 *
 * The two literal sets are deliberately different: `ServerProviderState` is
 * about whether a provider is *usable* (`warning` covers "works but something
 * is off"), while the Agent page asks whether the agent is *reachable*. A
 * disabled instance reports `disabled` regardless of its probe result, because
 * "we are not talking to this agent" is the honest answer.
 */
export function resolveConnectionStatus(
  provider: ServerProvider,
): ProviderInstanceConnection["status"] {
  if (!provider.enabled) {
    return "disabled";
  }
  switch (provider.status) {
    case "ready":
      return "ready";
    case "error":
      return "error";
    case "warning":
      // A reachable provider reporting a non-fatal problem. `detail` carries
      // the specifics; the badge stays honest by not claiming "ready".
      return "offline";
    case "disabled":
      return "disabled";
  }
}

function buildModelInfo(provider: ServerProvider): ProviderInstanceModelInfo | null {
  const model = resolveCurrentSnapshotModel(provider.models);
  const reasoningEffortLabel = resolveReasoningEffortLabel(model);
  if (!model && reasoningEffortLabel === null) {
    return null;
  }
  return {
    id: model?.slug ?? null,
    displayName: model?.name ?? null,
    vendor: model?.subProvider ?? null,
    // Not carried on `ServerProviderModel` today. Kept in the contract so the
    // shape is stable when a driver starts reporting it.
    contextWindow: null,
    reasoningEffortLabel,
  };
}

/**
 * Default description, derived entirely from a `ServerProvider` snapshot.
 *
 * `describedAt` is passed in rather than read from the clock so this stays a
 * pure function — the caller stamps it from the Effect clock.
 */
export function describeFromServerProvider(input: {
  readonly provider: ServerProvider;
  readonly describedAt: string;
}): ProviderInstanceDescription {
  const { provider, describedAt } = input;
  return {
    identity: {
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? provider.instanceId,
      agentVersion: provider.version,
      pluginVersion: null,
      protocolVersion: null,
      host: null,
    },
    connection: {
      status: resolveConnectionStatus(provider),
      detail: provider.message ?? provider.unavailableReason ?? null,
      // Local-process drivers have no connection timeline to report; the
      // probe timestamp is the closest honest analogue.
      lastConnectedAt: provider.status === "ready" ? provider.checkedAt : null,
      activeSessionCount: null,
      connectionGeneration: null,
    },
    model: buildModelInfo(provider),
    skills: provider.skills,
    capabilities: null,
    describedAt,
  };
}
