/**
 * Environment-scoped "a server restart is expected" overlay.
 *
 * Set around a server self-update so the connection UI can tell an
 * intentional restart apart from a genuine outage: while the window is
 * active, disconnects present as a calm "restarting" notice and the client
 * retries on a fast flat cadence instead of escalating backoff. This is
 * deliberately not a connection-supervisor phase — the supervisor state
 * machine stays transport-only, and this store is UI-side intent that
 * expires on its own if the server never comes back.
 *
 * The window is intentionally write-once-and-expire: it is armed while the
 * old server is still connected (the acknowledgement races its own
 * disconnect), and nothing observed on the connection can reliably end it
 * early. Presentation gates on the environment actually being unavailable,
 * so a lingering window is inert once the replacement is back.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useReducer } from "react";
import { create } from "zustand";

/**
 * How long after the last update signal (dispatch, RPC acknowledgement, or
 * interrupted RPC) a disconnect is still attributed to the restart. Covers
 * the respawn shim (~3s), boot-service systemd swap, server boot, and relay
 * re-registration with generous margin; after it lapses the normal error
 * presentation returns.
 */
export const SERVER_RESTART_EXPECTED_WINDOW_MS = 90_000;

interface ServerRestartState {
  readonly expiresAtByEnvironmentId: Readonly<Record<string, number>>;
  readonly expect: (environmentId: EnvironmentId) => void;
  readonly clear: (environmentId: EnvironmentId) => void;
}

export const useServerRestartStore = create<ServerRestartState>()((set) => ({
  expiresAtByEnvironmentId: {},
  expect: (environmentId) =>
    set((state) => ({
      expiresAtByEnvironmentId: {
        ...state.expiresAtByEnvironmentId,
        [environmentId]: Date.now() + SERVER_RESTART_EXPECTED_WINDOW_MS,
      },
    })),
  clear: (environmentId) =>
    set((state) => {
      if (!(environmentId in state.expiresAtByEnvironmentId)) {
        return state;
      }
      const next = { ...state.expiresAtByEnvironmentId };
      delete next[environmentId];
      return { expiresAtByEnvironmentId: next };
    }),
}));

export function expectServerRestart(environmentId: EnvironmentId): void {
  useServerRestartStore.getState().expect(environmentId);
}

export function clearExpectedServerRestart(environmentId: EnvironmentId): void {
  useServerRestartStore.getState().clear(environmentId);
}

/**
 * Whether an unexpired restart window is armed for the environment.
 * Re-renders when the window is armed, cleared, or lapses.
 */
export function useServerRestartExpected(environmentId: EnvironmentId | null): boolean {
  const expiresAt = useServerRestartStore((state) =>
    environmentId === null ? null : (state.expiresAtByEnvironmentId[environmentId] ?? null),
  );
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (expiresAt === null) {
      return;
    }
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      return;
    }
    const timer = setTimeout(tick, remaining + 50);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expiresAt !== null && expiresAt > Date.now();
}

/**
 * Whether the environment should be presented as restarting rather than as an
 * outage. Requires the environment to actually be away, which is why a window
 * that outlives its restart is harmless: a reconnected environment reports
 * false regardless of the window.
 */
export function isServerRestarting(input: {
  readonly restartExpected: boolean;
  readonly environmentUnavailable: boolean;
}): boolean {
  return input.restartExpected && input.environmentUnavailable;
}

/**
 * Whether an expected restart has resolved without delivering a new version,
 * so UI held for it should be released.
 *
 * The update RPC is acknowledged before the restart runs, so a rejected
 * restart cannot report itself through the call. Two shapes resolve it,
 * because a rejected restart may or may not have dropped the connection:
 * the environment went away and came back (something restarted, but the skew
 * is still here), or the window lapsed while the connection never dropped
 * (no restart ever happened).
 */
export function isExpectedRestartResolved(input: {
  /** A restart window was observed as armed at some point. */
  readonly sawRestartWindow: boolean;
  /** A restart window is armed right now. */
  readonly restartExpected: boolean;
  /** The environment has been unavailable at some point since arming. */
  readonly wentAway: boolean;
  readonly environmentUnavailable: boolean;
}): boolean {
  if (input.environmentUnavailable) {
    return false;
  }
  if (input.wentAway) {
    return true;
  }
  return input.sawRestartWindow && !input.restartExpected;
}
