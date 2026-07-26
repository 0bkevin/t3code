/**
 * Drives expected-restart reconnection for every environment with an armed
 * restart window, wherever the update was triggered from.
 *
 * This is mounted once at the app level rather than in a route: the update
 * action appears in the chat composer's version-mismatch banner *and* in
 * Settings → Connections, and the restart it schedules outlives whatever view
 * the user happens to be on. Scoping this to one view meant an update started
 * from Settings got no fast reconnect and left its window uncleared.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "./connection/catalog";
import { clearExpectedServerRestart, useServerRestartStore } from "./serverRestartStore";
import { useEnvironments } from "./state/environments";
import { useAtomCommand } from "./state/use-atom-command";

/**
 * Retry cadence while a restart is expected. Starts fast — a restart is back
 * in seconds, and the supervisor's own 1s→16s escalation is what strands the
 * client — then eases off so a server that never returns is not polled at a
 * fixed 2s for the whole window.
 */
const RETRY_DELAYS_MS = [2_000, 2_000, 3_000, 5_000, 8_000] as const;

/**
 * Upper bound on pokes per restart window. The window is a duration, not a
 * budget, so without a cap a slow-starting server would be retried for its
 * full length; each poke tears down and rebuilds a connection attempt, so a
 * runaway loop is real work. Reaching the cap leaves normal supervisor
 * backoff in charge, which is the correct end state for a server that is not
 * coming back.
 */
export const MAX_RETRIES_PER_WINDOW = 12;

export function restartRetryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 8_000;
}

/**
 * Whether to poke the supervisor for an environment inside a restart window.
 * Requires a supervisor asleep in backoff (waking a live attempt restarts it,
 * making reconnection slower) and an unspent retry budget.
 */
export function shouldPokeRestartRetry(input: {
  readonly connected: boolean;
  readonly retryAt: number | null;
  readonly attempts: number;
}): boolean {
  if (input.connected || input.retryAt == null) {
    return false;
  }
  return input.attempts < MAX_RETRIES_PER_WINDOW;
}

interface RestartProgress {
  /** Pokes issued for the current window. */
  attempts: number;
  /** The restart's disconnect has been observed for this window. */
  sawDisconnect: boolean;
  /** Window identity, so a re-armed window restarts the budget. */
  expiresAt: number;
}

export function useServerRestartReconnect(): void {
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const expiresAtByEnvironmentId = useServerRestartStore((state) => state.expiresAtByEnvironmentId);
  const { environments } = useEnvironments();
  const progressRef = useRef(new Map<string, RestartProgress>());

  // Effects key off primitives so an unstable environment array identity
  // cannot restart the timer on every unrelated render.
  const armed = environments
    .filter((environment) => expiresAtByEnvironmentId[environment.environmentId] !== undefined)
    .map((environment) => ({
      environmentId: environment.environmentId,
      expiresAt: expiresAtByEnvironmentId[environment.environmentId] ?? 0,
      connected: environment.connection.phase === "connected",
      // Only wake a supervisor that is asleep in backoff; interrupting a live
      // attempt would restart it and make things slower, not faster.
      retryAt: environment.connection.retryAt,
    }));
  const armedKey = armed
    .map(
      (entry) =>
        `${entry.environmentId}:${entry.expiresAt}:${String(entry.connected)}:${String(entry.retryAt ?? 0)}`,
    )
    .join("|");

  useEffect(() => {
    const progress = progressRef.current;
    for (const key of Array.from(progress.keys())) {
      if (!armed.some((entry) => entry.environmentId === key)) {
        progress.delete(key);
      }
    }

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    for (const entry of armed) {
      const current = progress.get(entry.environmentId);
      const state: RestartProgress =
        current === undefined || current.expiresAt !== entry.expiresAt
          ? {
              attempts: 0,
              sawDisconnect: current?.sawDisconnect ?? false,
              expiresAt: entry.expiresAt,
            }
          : current;
      progress.set(entry.environmentId, state);

      if (entry.connected) {
        // Ending the window needs the disconnect to have been seen first: it
        // is armed while the old server is still connected, so "connected"
        // alone would clear it before the restart it exists to cover. Never
        // clearing is equally wrong — a later unrelated outage would then be
        // dressed up as an intentional restart.
        if (state.sawDisconnect) {
          progress.delete(entry.environmentId);
          clearExpectedServerRestart(entry.environmentId as EnvironmentId);
        }
        continue;
      }

      state.sawDisconnect = true;
      if (
        !shouldPokeRestartRetry({
          connected: entry.connected,
          retryAt: entry.retryAt,
          attempts: state.attempts,
        })
      ) {
        continue;
      }
      const delay = restartRetryDelayMs(state.attempts);
      timers.push(
        setTimeout(() => {
          state.attempts += 1;
          void retryEnvironment(entry.environmentId as EnvironmentId);
        }, delay),
      );
    }
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
    // armedKey is the stable serialization of `armed`; depending on the array
    // itself would re-run this on every render.
  }, [armedKey, retryEnvironment]);
}
