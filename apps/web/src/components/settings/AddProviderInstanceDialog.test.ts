import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";

import {
  createHermesProviderInstanceId,
  isHermesInstanceRemovedError,
  isOwnedHermesEnrollmentRetry,
  resolveHermesWaitingState,
  resolveWizardNavigation,
  rollbackProviderInstances,
  validateProviderInstanceIdForWizard,
} from "./AddProviderInstanceDialog.logic";

describe("Hermes provider instance identity", () => {
  it("keeps the readable label prefix while adding a stable random suffix", () => {
    expect(
      createHermesProviderInstanceId("Research Team", () => "019f99cc-30d4-72c4-b3dd-2ee59cecb856"),
    ).toBe("hermes-research-team-019f99cc30d4");
  });

  it("never reuses an ID when a later dialog uses the same label", () => {
    expect(
      createHermesProviderInstanceId("Research", () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    ).not.toBe(
      createHermesProviderInstanceId("Research", () => "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
    );
  });

  it("stays within the provider instance ID length limit for long labels", () => {
    const instanceId = createHermesProviderInstanceId(
      "A very long research Hermes display name that should be truncated before persistence",
      () => "019f99cc-30d4-72c4-b3dd-2ee59cecb856",
    );

    expect(instanceId.length).toBeLessThanOrEqual(64);
    expect(instanceId).toMatch(/^hermes-[a-z0-9-]+-[a-z0-9]{12}$/u);
  });

  it("recognizes a server tombstone rejection so the dialog can rotate its nonce", () => {
    expect(isHermesInstanceRemovedError({ code: "instance-removed" })).toBe(true);
    expect(isHermesInstanceRemovedError({ code: "nickname-conflict" })).toBe(false);
    expect(isHermesInstanceRemovedError(new Error("instance removed"))).toBe(false);
  });
});

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Instance ID is required." };
  const validId = { instanceIdError: null };

  it("allows moving from Driver to Identity before the instance id is valid", () => {
    expect(resolveWizardNavigation(0, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
  });

  it("blocks Next from Identity to Config while the instance id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("stops a direct Driver-to-Config skip at Identity and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("allows advancing and skipping forward once the instance id is valid", () => {
    expect(resolveWizardNavigation(1, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
  });

  it("always preserves backward Driver and Identity navigation", () => {
    expect(resolveWizardNavigation(2, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
    expect(resolveWizardNavigation(2, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
    expect(resolveWizardNavigation(1, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });

  it("clamps requested steps to the wizard bounds", () => {
    expect(resolveWizardNavigation(2, 8, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, -1, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });
});

describe("Hermes enrollment retry ownership", () => {
  const existingIds = new Set(["hermes-research", "hermes-existing"]);

  it("allows retrying enrollment for the exact Hermes instance created by this wizard", () => {
    expect(
      isOwnedHermesEnrollmentRetry({
        driver: ProviderDriverKind.make("hermes"),
        instanceId: "hermes-research",
        createdHermesInstanceId: "hermes-research",
      }),
    ).toBe(true);
    expect(
      validateProviderInstanceIdForWizard({
        driver: ProviderDriverKind.make("hermes"),
        instanceId: "hermes-research",
        existingIds,
        createdHermesInstanceId: "hermes-research",
      }),
    ).toBeNull();
  });

  it("still rejects arbitrary existing instances and non-Hermes reuse", () => {
    expect(
      validateProviderInstanceIdForWizard({
        driver: ProviderDriverKind.make("hermes"),
        instanceId: "hermes-existing",
        existingIds,
        createdHermesInstanceId: "hermes-research",
      }),
    ).toContain("already exists");
    expect(
      validateProviderInstanceIdForWizard({
        driver: ProviderDriverKind.make("codex"),
        instanceId: "hermes-research",
        existingIds,
        createdHermesInstanceId: "hermes-research",
      }),
    ).toContain("already exists");
    expect(
      validateProviderInstanceIdForWizard({
        driver: ProviderDriverKind.make("hermes"),
        instanceId: "hermes-research",
        existingIds,
        createdHermesInstanceId: null,
      }),
    ).toContain("already exists");
  });
});

describe("rollbackProviderInstances", () => {
  interface TestInstance {
    readonly driver: string;
    readonly enabled: boolean;
  }
  const written: TestInstance = { driver: "hermes", enabled: true };
  const other: TestInstance = { driver: "codex", enabled: true };

  it("removes only the instance this dialog wrote", () => {
    expect(
      rollbackProviderInstances({
        latest: { "hermes-a": written, codex_work: other },
        instanceId: "hermes-a",
        written,
      }),
    ).toEqual({ codex_work: other });
  });

  it("preserves instances another client added between the write and the rollback", () => {
    const concurrent: TestInstance = { driver: "claude", enabled: true };
    expect(
      rollbackProviderInstances({
        latest: { "hermes-a": written, "added-elsewhere": concurrent },
        instanceId: "hermes-a",
        written,
      }),
    ).toEqual({ "added-elsewhere": concurrent });
  });

  it("does nothing when the id is already gone or was replaced by a different config", () => {
    expect(
      rollbackProviderInstances({ latest: { codex_work: other }, instanceId: "hermes-a", written }),
    ).toBeNull();
    expect(
      rollbackProviderInstances({
        latest: { "hermes-a": { ...written } },
        instanceId: "hermes-a",
        written,
      }),
    ).toBeNull();
  });
});

describe("resolveHermesWaitingState", () => {
  it("treats a not-yet-dialled-in gateway as an expected pending wait, not an error", () => {
    expect(resolveHermesWaitingState({ connectionState: null, isExpired: false })).toEqual({
      phase: "waiting",
      statusLabelState: "offline",
      isPending: true,
      needsNewCommand: false,
    });
    expect(resolveHermesWaitingState({ connectionState: "offline", isExpired: false })).toEqual({
      phase: "waiting",
      statusLabelState: "offline",
      isPending: true,
      needsNewCommand: false,
    });
    expect(resolveHermesWaitingState({ connectionState: "connecting", isExpired: false })).toEqual({
      phase: "waiting",
      statusLabelState: "connecting",
      isPending: true,
      needsNewCommand: false,
    });
  });

  it("flips to connected and ignores expiry once the gateway has dialled in", () => {
    expect(resolveHermesWaitingState({ connectionState: "connected", isExpired: true })).toEqual({
      phase: "connected",
      statusLabelState: "connected",
      isPending: false,
      needsNewCommand: false,
    });
  });

  it("offers a fresh command when the one-time token expired unused", () => {
    expect(resolveHermesWaitingState({ connectionState: "offline", isExpired: true })).toEqual({
      phase: "expired",
      statusLabelState: "offline",
      isPending: false,
      needsNewCommand: true,
    });
  });

  it("surfaces upgrade-required and revoked ahead of waiting, since neither resolves by waiting", () => {
    expect(
      resolveHermesWaitingState({ connectionState: "upgrade-required", isExpired: false }),
    ).toEqual({
      phase: "blocked",
      statusLabelState: "upgrade-required",
      isPending: false,
      // A protocol upgrade needs a new plugin, not a new token.
      needsNewCommand: false,
    });
    expect(resolveHermesWaitingState({ connectionState: "revoked", isExpired: false })).toEqual({
      phase: "blocked",
      statusLabelState: "revoked",
      isPending: false,
      needsNewCommand: true,
    });
  });
});
