import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderInstanceRequiresWorkspace,
  getProviderRequiresWorkspace,
} from "./providerModels";

function provider(input: {
  driver: string;
  instanceId: string;
  requiresWorkspace?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.requiresWorkspace === undefined
      ? {}
      : { requiresWorkspace: input.requiresWorkspace }),
  };
}

const codexKind = ProviderDriverKind.make("codex");

describe("getProviderRequiresWorkspace", () => {
  it("treats an absent field as true so existing providers keep their directory UI", () => {
    expect(
      getProviderRequiresWorkspace([provider({ driver: "codex", instanceId: "codex" })], codexKind),
    ).toBe(true);
  });

  it("honors an explicit false", () => {
    expect(
      getProviderRequiresWorkspace(
        [provider({ driver: "codex", instanceId: "codex", requiresWorkspace: false })],
        codexKind,
      ),
    ).toBe(false);
  });

  it("honors an explicit true", () => {
    expect(
      getProviderRequiresWorkspace(
        [provider({ driver: "codex", instanceId: "codex", requiresWorkspace: true })],
        codexKind,
      ),
    ).toBe(true);
  });

  it("returns true for an unknown driver rather than crashing", () => {
    expect(
      getProviderRequiresWorkspace(
        [provider({ driver: "codex", instanceId: "codex", requiresWorkspace: false })],
        ProviderDriverKind.make("someForkDriver"),
      ),
    ).toBe(true);
  });

  it("returns true for an empty providers array", () => {
    expect(getProviderRequiresWorkspace([], codexKind)).toBe(true);
  });

  it("ignores non-default instances of the same driver kind", () => {
    // The lookup is keyed on `defaultInstanceIdForDriver`, so a custom
    // instance's flag must not leak onto the driver-kind read.
    expect(
      getProviderRequiresWorkspace(
        [provider({ driver: "codex", instanceId: "codex_personal", requiresWorkspace: false })],
        codexKind,
      ),
    ).toBe(true);
  });
});

describe("getProviderInstanceRequiresWorkspace", () => {
  const hermesInstanceId = ProviderInstanceId.make("hermes-research-a1b2c3d4e5f6");

  it("resolves a user-authored instance that the driver-kind lookup cannot reach", () => {
    const providers = [
      provider({
        driver: "hermes",
        instanceId: "hermes-research-a1b2c3d4e5f6",
        requiresWorkspace: false,
      }),
    ];

    expect(getProviderInstanceRequiresWorkspace(providers, hermesInstanceId)).toBe(false);
    // No `hermes` default instance is ever synthesized, so the kind-keyed
    // accessor cannot see this snapshot at all.
    expect(getProviderRequiresWorkspace(providers, ProviderDriverKind.make("hermes"))).toBe(true);
  });

  it("treats an absent field as true", () => {
    expect(
      getProviderInstanceRequiresWorkspace(
        [provider({ driver: "codex", instanceId: "codex" })],
        ProviderInstanceId.make("codex"),
      ),
    ).toBe(true);
  });

  it("returns true for an unknown instance", () => {
    expect(
      getProviderInstanceRequiresWorkspace(
        [provider({ driver: "codex", instanceId: "codex", requiresWorkspace: false })],
        ProviderInstanceId.make("codex_missing"),
      ),
    ).toBe(true);
  });

  it("returns true for a null or undefined instance id", () => {
    const providers = [
      provider({ driver: "codex", instanceId: "codex", requiresWorkspace: false }),
    ];
    expect(getProviderInstanceRequiresWorkspace(providers, null)).toBe(true);
    expect(getProviderInstanceRequiresWorkspace(providers, undefined)).toBe(true);
  });

  it("returns true for an empty providers array", () => {
    expect(getProviderInstanceRequiresWorkspace([], hermesInstanceId)).toBe(true);
  });
});
