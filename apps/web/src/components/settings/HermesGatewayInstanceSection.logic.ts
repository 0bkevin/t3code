import type { HermesGatewayConnectionState, ServerProvider } from "@t3tools/contracts";

export const HERMES_GATEWAY_SOCKET_PATH = "/api/hermes-gateway/ws";

export function defaultHermesConnectorUrl(origin: string): string {
  return new URL(HERMES_GATEWAY_SOCKET_PATH, origin).toString();
}

export function shouldApplyHermesConnectorStatusUrl(hasLocalEdits: boolean): boolean {
  return !hasLocalEdits;
}

export function hermesGatewayStatusLabel(status: HermesGatewayConnectionState): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "upgrade-required":
      return "Upgrade required";
    case "revoked":
      return "Revoked";
    case "offline":
      return "Offline";
  }
}

/**
 * Actionable follow-up for each connection state.
 *
 * `upgrade-required` in particular is not a transient condition: the plugin
 * negotiated an incompatible protocol version and the connection was closed,
 * so the user has to reinstall the plugin rather than wait.
 */
export function hermesGatewayStatusGuidance(status: HermesGatewayConnectionState): string {
  switch (status) {
    case "connected":
      return "Hermes is connected. You can start sending it messages.";
    case "connecting":
      return "Hermes is completing its handshake with T3 Code.";
    case "upgrade-required":
      return "This Hermes host runs an incompatible T3 Code gateway plugin. Re-run the install script on that host to update the plugin, then run 'hermes gateway restart'.";
    case "revoked":
      return "This gateway's credential was revoked. Generate a new command to pair it again.";
    case "offline":
      return "Hermes has not dialled in yet. Run the command on the Hermes host, then run 'hermes gateway restart'.";
  }
}

export function canRemoveHermesGatewayInstance(status: HermesGatewayConnectionState): boolean {
  return status === "revoked";
}

/**
 * Coarse liveness read of a Hermes instance taken from the server-pushed
 * provider snapshot.
 *
 * `ServerProvider` already streams to every client over `subscribeServerConfig`
 * whenever the broker publishes a gateway status change, so surfaces that only
 * need "has Hermes dialled in yet?" can flip off it without polling. The
 * snapshot deliberately does not carry the full `HermesGatewayConnectionState`,
 * so callers that need `upgrade-required` / `revoked` still read the
 * authoritative status once this signal changes.
 */
export interface HermesGatewayProviderSignal {
  readonly present: boolean;
  readonly connected: boolean;
  /**
   * Changes on every republished snapshot, including ones whose connected flag
   * is unchanged. `upgrade-required` closes the connection, so it looks
   * identical to "still offline" through `connected` alone — watching this
   * instead means such a transition still triggers an authoritative re-read.
   */
  readonly revision: string | null;
}

export function hermesGatewayProviderSignal(
  providers: readonly ServerProvider[],
  instanceId: string,
): HermesGatewayProviderSignal {
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  if (provider === undefined) return { present: false, connected: false, revision: null };
  return {
    present: true,
    connected: provider.auth.status === "authenticated",
    revision: provider.checkedAt,
  };
}

export function isHermesInstanceNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "instance-not-found"
  );
}

export function hermesGatewayLifecycleAction(input: {
  readonly status: HermesGatewayConnectionState;
  readonly instanceNotFound: boolean;
}): "revoke" | "remove-instance" | "remove-setup" {
  if (input.instanceNotFound) return "remove-setup";
  return canRemoveHermesGatewayInstance(input.status) ? "remove-instance" : "revoke";
}

export function formatHermesLastConnected(value: string | null): string {
  if (value === null) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Whether a one-time enrollment token has aged out.
 *
 * An unparseable timestamp is treated as still valid: the server is the real
 * authority on expiry, and refusing to show a command the user may well be
 * able to run would be worse than letting the paste fail loudly.
 */
export function isHermesEnrollmentExpired(expiresAt: string, nowMillis: number): boolean {
  const expiryMillis = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMillis)) return false;
  return expiryMillis <= nowMillis;
}

export function messageFromUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return "The Hermes gateway request failed.";
}
