import { describe, expect, it } from "vite-plus/test";

import {
  canRemoveHermesGatewayInstance,
  defaultHermesConnectorUrl,
  formatHermesLastConnected,
  hermesGatewayLifecycleAction,
  hermesGatewayProviderSignal,
  hermesGatewayStatusGuidance,
  hermesGatewayStatusLabel,
  isHermesEnrollmentExpired,
  isHermesInstanceNotFoundError,
  messageFromUnknownError,
  shouldApplyHermesConnectorStatusUrl,
} from "./HermesGatewayInstanceSection.logic";

describe("Hermes gateway settings logic", () => {
  it("uses the current origin with the gateway WebSocket route", () => {
    expect(defaultHermesConnectorUrl("https://siva.davis7.space:3774/settings")).toBe(
      "https://siva.davis7.space:3774/api/hermes-gateway/ws",
    );
  });

  it("provides useful labels for every connection state", () => {
    expect(
      ["offline", "connecting", "connected", "upgrade-required", "revoked"].map((status) =>
        hermesGatewayStatusLabel(status as never),
      ),
    ).toEqual(["Offline", "Connecting", "Connected", "Upgrade required", "Revoked"]);
  });

  it("only offers permanent removal after credentials are revoked", () => {
    expect(canRemoveHermesGatewayInstance("connected")).toBe(false);
    expect(canRemoveHermesGatewayInstance("offline")).toBe(false);
    expect(canRemoveHermesGatewayInstance("revoked")).toBe(true);
  });

  it("offers setup cleanup only for a structured missing-instance response", () => {
    expect(isHermesInstanceNotFoundError({ code: "instance-not-found" })).toBe(true);
    expect(isHermesInstanceNotFoundError(new Error("Network unavailable"))).toBe(false);
    expect(isHermesInstanceNotFoundError({ code: "internal-error" })).toBe(false);

    expect(hermesGatewayLifecycleAction({ status: "offline", instanceNotFound: true })).toBe(
      "remove-setup",
    );
    expect(hermesGatewayLifecycleAction({ status: "offline", instanceNotFound: false })).toBe(
      "revoke",
    );
    expect(hermesGatewayLifecycleAction({ status: "connected", instanceNotFound: false })).toBe(
      "revoke",
    );
    expect(hermesGatewayLifecycleAction({ status: "revoked", instanceNotFound: false })).toBe(
      "remove-instance",
    );
  });

  it("keeps invalid server timestamps readable and extracts structured messages", () => {
    expect(formatHermesLastConnected(null)).toBe("Never");
    expect(formatHermesLastConnected("not-a-date")).toBe("not-a-date");
    expect(messageFromUnknownError({ message: "Nickname is already used." })).toBe(
      "Nickname is already used.",
    );
  });

  it("does not replace an in-progress connector URL edit during status polling", () => {
    expect(shouldApplyHermesConnectorStatusUrl(false)).toBe(true);
    expect(shouldApplyHermesConnectorStatusUrl(true)).toBe(false);
  });
});

describe("Hermes waiting-state helpers", () => {
  it("tells the user the restart is expected rather than reporting a bare status", () => {
    expect(hermesGatewayStatusGuidance("offline")).toContain("hermes gateway restart");
    expect(hermesGatewayStatusGuidance("connected")).toContain("connected");
  });

  it("makes upgrade-required actionable by naming the plugin reinstall", () => {
    const guidance = hermesGatewayStatusGuidance("upgrade-required");
    expect(guidance).toContain("plugin");
    expect(guidance).toContain("install script");
  });

  it("points a revoked gateway at a new pairing command", () => {
    expect(hermesGatewayStatusGuidance("revoked")).toContain("new command");
  });

  it("expires a one-time token at its deadline but trusts the server on garbage input", () => {
    const expiresAt = "2026-07-24T12:00:00.000Z";
    const expiryMillis = Date.parse(expiresAt);

    expect(isHermesEnrollmentExpired(expiresAt, expiryMillis - 1)).toBe(false);
    expect(isHermesEnrollmentExpired(expiresAt, expiryMillis)).toBe(true);
    expect(isHermesEnrollmentExpired(expiresAt, expiryMillis + 60_000)).toBe(true);
    expect(isHermesEnrollmentExpired("not-a-date", expiryMillis)).toBe(false);
  });
});

describe("hermesGatewayProviderSignal", () => {
  const provider = (
    instanceId: string,
    status: "authenticated" | "unauthenticated",
    checkedAt = "2026-07-24T12:00:00.000Z",
  ) =>
    ({
      instanceId,
      driver: "hermes",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status, type: "gateway", label: "Hermes" },
      checkedAt,
      models: [],
      slashCommands: [],
      skills: [],
    }) as never;

  it("reports a connected gateway from the pushed provider snapshot", () => {
    expect(
      hermesGatewayProviderSignal([provider("hermes-a", "authenticated")], "hermes-a"),
    ).toEqual({ present: true, connected: true, revision: "2026-07-24T12:00:00.000Z" });
  });

  it("distinguishes an enrolled-but-not-yet-dialled-in gateway from a missing one", () => {
    expect(
      hermesGatewayProviderSignal([provider("hermes-a", "unauthenticated")], "hermes-a"),
    ).toEqual({ present: true, connected: false, revision: "2026-07-24T12:00:00.000Z" });
    expect(hermesGatewayProviderSignal([], "hermes-a")).toEqual({
      present: false,
      connected: false,
      revision: null,
    });
  });

  it("changes revision when a republished snapshot leaves the connected flag untouched", () => {
    // An `upgrade-required` transition closes the connection, so `connected`
    // stays false across the republish; only `revision` moves.
    const before = hermesGatewayProviderSignal(
      [provider("hermes-a", "unauthenticated")],
      "hermes-a",
    );
    const after = hermesGatewayProviderSignal(
      [provider("hermes-a", "unauthenticated", "2026-07-24T12:05:00.000Z")],
      "hermes-a",
    );

    expect(after.connected).toBe(before.connected);
    expect(after.revision).not.toBe(before.revision);
  });
});
