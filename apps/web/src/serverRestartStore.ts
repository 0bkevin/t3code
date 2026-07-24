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

interface ServerRestartWindow {
  readonly expiresAt: number;
  /**
   * Whether the environment has actually gone away since the window was
   * armed. The window is armed while the old server is still connected — that
   * is the point, since the acknowledgement races its own disconnect — so a
   * connected environment must not end the window until the restart it is
   * waiting for has been observed.
   */
  readonly sawDisconnect: boolean;
}

interface ServerRestartState {
  readonly windowByEnvironmentId: Readonly<Record<string, ServerRestartWindow>>;
  readonly expect: (environmentId: EnvironmentId) => void;
  readonly markDisconnected: (environmentId: EnvironmentId) => void;
  readonly clear: (environmentId: EnvironmentId) => void;
}

export const useServerRestartStore = create<ServerRestartState>()((set) => ({
  windowByEnvironmentId: {},
  expect: (environmentId) =>
    set((state) => ({
      windowByEnvironmentId: {
        ...state.windowByEnvironmentId,
        [environmentId]: {
          expiresAt: Date.now() + SERVER_RESTART_EXPECTED_WINDOW_MS,
          // Re-arming (a slow install acknowledging late) must not forget a
          // disconnect that was already observed.
          sawDisconnect: state.windowByEnvironmentId[environmentId]?.sawDisconnect ?? false,
        },
      },
    })),
  markDisconnected: (environmentId) =>
    set((state) => {
      const current = state.windowByEnvironmentId[environmentId];
      if (current === undefined || current.sawDisconnect) {
        return state;
      }
      return {
        windowByEnvironmentId: {
          ...state.windowByEnvironmentId,
          [environmentId]: { ...current, sawDisconnect: true },
        },
      };
    }),
  clear: (environmentId) =>
    set((state) => {
      if (!(environmentId in state.windowByEnvironmentId)) {
        return state;
      }
      const next = { ...state.windowByEnvironmentId };
      delete next[environmentId];
      return { windowByEnvironmentId: next };
    }),
}));

export function expectServerRestart(environmentId: EnvironmentId): void {
  useServerRestartStore.getState().expect(environmentId);
}

/** Records that the expected restart's disconnect has now been observed. */
export function markServerRestartDisconnected(environmentId: EnvironmentId): void {
  useServerRestartStore.getState().markDisconnected(environmentId);
}

export function clearExpectedServerRestart(environmentId: EnvironmentId): void {
  useServerRestartStore.getState().clear(environmentId);
}

export interface ServerRestartExpectation {
  /** An unexpired restart window is armed for this environment. */
  readonly expected: boolean;
  /** The restart's disconnect has been observed, so a reconnect ends it. */
  readonly sawDisconnect: boolean;
}

/**
 * Whether an armed restart window has run its course: the disconnect was
 * observed and the window has since closed. Callers use this to recover UI
 * that was held for the restart — the update RPC is acknowledged before the
 * restart runs, so a rejected restart cannot report itself through the call.
 *
 * Note that a window which never saw a disconnect is not "settled": the
 * restart simply never happened, and other paths (an explicit RPC failure)
 * own that case.
 */
export function isServerRestartSettled(expectation: ServerRestartExpectation): boolean {
  return expectation.sawDisconnect && !expectation.expected;
}

/**
 * Whether the environment should currently be presented as restarting rather
 * than as an outage: a live window plus an environment that is actually away.
 */
export function isServerRestarting(input: {
  readonly expectation: ServerRestartExpectation;
  readonly environmentUnavailable: boolean;
}): boolean {
  return input.expectation.expected && input.environmentUnavailable;
}

/**
 * The restart window state for an environment. Re-renders when the window is
 * armed, observes its disconnect, is cleared, or lapses.
 */
export function useServerRestartExpectation(
  environmentId: EnvironmentId | null,
): ServerRestartExpectation {
  const window = useServerRestartStore((state) =>
    environmentId === null ? null : (state.windowByEnvironmentId[environmentId] ?? null),
  );
  const expiresAt = window?.expiresAt ?? null;
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
  return {
    expected: expiresAt !== null && expiresAt > Date.now(),
    sawDisconnect: window?.sawDisconnect === true,
  };
}
