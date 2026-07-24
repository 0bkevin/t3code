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
  readonly expectedUntilByEnvironmentId: Readonly<Record<string, number>>;
  readonly expect: (environmentId: EnvironmentId) => void;
  readonly clear: (environmentId: EnvironmentId) => void;
}

export const useServerRestartStore = create<ServerRestartState>()((set) => ({
  expectedUntilByEnvironmentId: {},
  expect: (environmentId) =>
    set((state) => ({
      expectedUntilByEnvironmentId: {
        ...state.expectedUntilByEnvironmentId,
        [environmentId]: Date.now() + SERVER_RESTART_EXPECTED_WINDOW_MS,
      },
    })),
  clear: (environmentId) =>
    set((state) => {
      if (!(environmentId in state.expectedUntilByEnvironmentId)) {
        return state;
      }
      const next = { ...state.expectedUntilByEnvironmentId };
      delete next[environmentId];
      return { expectedUntilByEnvironmentId: next };
    }),
}));

export function expectServerRestart(environmentId: EnvironmentId): void {
  useServerRestartStore.getState().expect(environmentId);
}

export function clearExpectedServerRestart(environmentId: EnvironmentId): void {
  useServerRestartStore.getState().clear(environmentId);
}

/**
 * Whether a restart window is currently active for the environment.
 * Re-renders when the window is set, cleared, or lapses.
 */
export function useServerRestartExpected(environmentId: EnvironmentId | null): boolean {
  const expiresAt = useServerRestartStore((state) =>
    environmentId === null ? null : (state.expectedUntilByEnvironmentId[environmentId] ?? null),
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
