import type { ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { ConnectionAttemptError, NetworkStatus, SupervisorConnectionState } from "./model.ts";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

export type EnvironmentConnectionFailureReason = ConnectionAttemptError["reason"];

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly reason: EnvironmentConnectionFailureReason | null;
  readonly traceId: string | null;
  /** Epoch ms of the next scheduled attempt while the supervisor sleeps in
      backoff; null while an attempt is live. Callers that want to retry
      early (retryNow) should only do so while this is set — waking an
      in-flight attempt cancels and restarts it. */
  readonly retryAt: number | null;
}

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: ServerConfig | null;
}

/**
 * Transport errors carry internal endpoint URLs and raw causes (see
 * rpc/http.ts) that belong in diagnostics, not user-facing banners. Present
 * a stable per-reason summary instead; the raw message stays available on
 * the supervisor state for connection diagnostics.
 */
export function connectionFailureSummary(failure: ConnectionAttemptError): string {
  switch (failure.reason) {
    case "network":
      return "The environment could not be reached.";
    case "transport":
      return "The connection to the environment was interrupted.";
    case "timeout":
      return "The environment did not respond in time.";
    case "endpoint-unavailable":
    case "remote-unavailable":
      return "The environment is not accepting connections yet.";
    case "relay-unavailable":
      return "The relay is temporarily unavailable.";
    // Blocked reasons are actionable, and their details are authored
    // messages (errors.ts) rather than raw transport dumps.
    case "authentication":
    case "permission":
    case "configuration":
    case "unsupported":
      return failure.message;
  }
}

function presentFailure(failure: ConnectionAttemptError | null): {
  readonly error: string | null;
  readonly reason: EnvironmentConnectionFailureReason | null;
  readonly traceId: string | null;
} {
  if (failure === null) {
    return { error: null, reason: null, traceId: null };
  }
  return {
    error: connectionFailureSummary(failure),
    reason: failure.reason,
    traceId: failure.traceId ?? null,
  };
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", ...presentFailure(null), retryAt: null };
    case "offline":
      return { phase: "offline", ...presentFailure(null), retryAt: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        ...presentFailure(state.lastFailure),
        retryAt: null,
      };
    case "connected":
      return { phase: "connected", ...presentFailure(null), retryAt: null };
    case "backoff":
      return {
        phase: "reconnecting",
        ...presentFailure(state.lastFailure),
        retryAt: state.retryAt,
      };
    case "blocked":
      return {
        phase: "error",
        ...presentFailure(state.lastFailure),
        retryAt: null,
      };
  }
}

/** The status helpers only read phase and error, so callers holding a phase
    and a message do not have to synthesize a whole presentation. traceId is
    accepted (and ignored) because callers commonly carry it alongside. */
export interface ConnectionStatusTextInput {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId?: string | null;
}

export function connectionStatusText(connection: ConnectionStatusTextInput): string {
  switch (connection.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      return connection.error
        ? `Failed to connect. Reconnecting... Reason: ${connection.error}`
        : "Reconnecting...";
    case "connected":
      return "Connected";
    case "error":
      return connection.error
        ? `Connection failed. Reason: ${connection.error}`
        : "Connection failed";
  }
}

export function connectionStatusTitle(connection: ConnectionStatusTextInput): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return "Failed to connect. Reconnecting...";
  }
  return connectionStatusText({ ...connection, error: null });
}

export function presentEnvironmentConnection(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  return presentConnectionState(state);
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}

export function connectionPhaseMessage(
  phase: EnvironmentConnectionPhase,
  label: string,
  networkStatus: NetworkStatus,
): string {
  if (networkStatus === "offline" || phase === "offline") {
    return "You are offline";
  }
  switch (phase) {
    case "available":
      return "Available";
    case "connecting":
      return `Connecting to ${label}...`;
    case "reconnecting":
      return `Reconnecting to ${label}...`;
    case "connected":
      return "Connected";
    case "error":
      return "Connection failed";
  }
}
