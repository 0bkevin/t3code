import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  describeFromServerProvider,
  resolveConnectionStatus,
  resolveCurrentSnapshotModel,
  resolveReasoningEffortLabel,
} from "./providerDescribe.ts";

const DESCRIBED_AT = "2024-05-01T12:00:00.000Z";

const makeProvider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.2.3",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2024-05-01T11:59:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const makeModel = (overrides: Partial<ServerProviderModel> = {}): ServerProviderModel => ({
  slug: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

describe("resolveCurrentSnapshotModel", () => {
  it("prefers the model flagged isDefault over list order", () => {
    const model = resolveCurrentSnapshotModel([
      makeModel({ slug: "first" }),
      makeModel({ slug: "flagged", isDefault: true }),
    ]);
    assert.strictEqual(model?.slug, "flagged");
  });

  it("falls back to the first model when nothing is flagged", () => {
    const model = resolveCurrentSnapshotModel([
      makeModel({ slug: "first" }),
      makeModel({ slug: "second" }),
    ]);
    assert.strictEqual(model?.slug, "first");
  });

  it("returns undefined rather than fabricating a model", () => {
    assert.strictEqual(resolveCurrentSnapshotModel([]), undefined);
  });
});

describe("resolveReasoningEffortLabel", () => {
  it("resolves the label for a driver's own effort option id", () => {
    const label = resolveReasoningEffortLabel(
      makeModel({
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select",
              currentValue: "high",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      }),
    );
    assert.strictEqual(label, "High");
  });

  it("resolves Cursor's differently-named option id", () => {
    const label = resolveReasoningEffortLabel(
      makeModel({
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoning",
              label: "Reasoning",
              type: "select",
              options: [{ id: "balanced", label: "Balanced", isDefault: true }],
            },
          ],
        },
      }),
    );
    // No currentValue — falls through to the descriptor's own default.
    assert.strictEqual(label, "Balanced");
  });

  it("matches a normalized id variant", () => {
    const label = resolveReasoningEffortLabel(
      makeModel({
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoning_effort",
              label: "Effort",
              type: "select",
              currentValue: "max",
              options: [{ id: "max", label: "Max" }],
            },
          ],
        },
      }),
    );
    assert.strictEqual(label, "Max");
  });

  it("returns null rather than guessing at an unrelated option", () => {
    const label = resolveReasoningEffortLabel(
      makeModel({
        capabilities: {
          optionDescriptors: [
            {
              id: "webSearch",
              label: "Web search",
              type: "boolean",
              currentValue: true,
            },
          ],
        },
      }),
    );
    assert.strictEqual(label, null);
  });

  it("returns null when the model reports no descriptors at all", () => {
    assert.strictEqual(resolveReasoningEffortLabel(makeModel()), null);
    assert.strictEqual(resolveReasoningEffortLabel(undefined), null);
  });
});

describe("resolveConnectionStatus", () => {
  it("reports disabled for a disabled instance regardless of probe result", () => {
    assert.strictEqual(
      resolveConnectionStatus(makeProvider({ enabled: false, status: "ready" })),
      "disabled",
    );
  });

  it("does not claim ready for a warning snapshot", () => {
    assert.strictEqual(resolveConnectionStatus(makeProvider({ status: "warning" })), "offline");
  });

  it("maps ready and error through directly", () => {
    assert.strictEqual(resolveConnectionStatus(makeProvider({ status: "ready" })), "ready");
    assert.strictEqual(resolveConnectionStatus(makeProvider({ status: "error" })), "error");
  });
});

describe("describeFromServerProvider", () => {
  it("projects identity, connection, model, and skills from the snapshot", () => {
    const description = describeFromServerProvider({
      provider: makeProvider({
        displayName: "Codex Work",
        models: [
          makeModel({
            isDefault: true,
            subProvider: "OpenAI",
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning effort",
                  type: "select",
                  currentValue: "medium",
                  options: [{ id: "medium", label: "Medium" }],
                },
              ],
            },
          }),
        ],
        skills: [{ name: "deploy", path: "/skills/deploy", enabled: true }],
      }),
      describedAt: DESCRIBED_AT,
    });

    assert.strictEqual(description.identity.displayName, "Codex Work");
    assert.strictEqual(description.identity.agentVersion, "1.2.3");
    assert.strictEqual(description.connection.status, "ready");
    assert.strictEqual(description.model?.id, "gpt-5.6-sol");
    assert.strictEqual(description.model?.vendor, "OpenAI");
    assert.strictEqual(description.model?.reasoningEffortLabel, "Medium");
    assert.strictEqual(description.skills.length, 1);
    assert.strictEqual(description.describedAt, DESCRIBED_AT);
  });

  it("falls back to the instance id when the snapshot has no display name", () => {
    const description = describeFromServerProvider({
      provider: makeProvider(),
      describedAt: DESCRIBED_AT,
    });
    assert.strictEqual(description.identity.displayName, "codex");
  });

  it("reports a null model block when the driver lists no models", () => {
    const description = describeFromServerProvider({
      provider: makeProvider({ models: [] }),
      describedAt: DESCRIBED_AT,
    });
    assert.strictEqual(description.model, null);
  });

  it("does not report a last-connected time for a provider that is not ready", () => {
    const description = describeFromServerProvider({
      provider: makeProvider({ status: "error", message: "codex CLI not found" }),
      describedAt: DESCRIBED_AT,
    });
    assert.strictEqual(description.connection.lastConnectedAt, null);
    assert.strictEqual(description.connection.detail, "codex CLI not found");
  });
});
