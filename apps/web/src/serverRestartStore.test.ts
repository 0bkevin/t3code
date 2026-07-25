import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  SERVER_RESTART_EXPECTED_WINDOW_MS,
  clearExpectedServerRestart,
  expectServerRestart,
  isExpectedRestartResolved,
  isServerRestarting,
  useServerRestartStore,
} from "./serverRestartStore";

const ENVIRONMENT_ID = "env-test" as EnvironmentId;

function expiresAtFor(environmentId: EnvironmentId) {
  return useServerRestartStore.getState().expiresAtByEnvironmentId[environmentId] ?? null;
}

describe("serverRestartStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useServerRestartStore.setState({ expiresAtByEnvironmentId: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms a window that expires on its own", () => {
    expectServerRestart(ENVIRONMENT_ID);
    expect(expiresAtFor(ENVIRONMENT_ID)).toBe(Date.now() + SERVER_RESTART_EXPECTED_WINDOW_MS);
  });

  it("extends the window when a slow install acknowledges late", () => {
    expectServerRestart(ENVIRONMENT_ID);
    vi.advanceTimersByTime(60_000);
    expectServerRestart(ENVIRONMENT_ID);

    // Re-arming from the acknowledgement is what keeps a restart that begins
    // minutes after the click from being presented as an outage.
    expect(expiresAtFor(ENVIRONMENT_ID)).toBe(Date.now() + SERVER_RESTART_EXPECTED_WINDOW_MS);
  });

  it("clears only the requested environment", () => {
    const other = "env-other" as EnvironmentId;
    expectServerRestart(ENVIRONMENT_ID);
    expectServerRestart(other);

    clearExpectedServerRestart(ENVIRONMENT_ID);

    expect(expiresAtFor(ENVIRONMENT_ID)).toBeNull();
    expect(expiresAtFor(other)).not.toBeNull();
  });

  describe("isServerRestarting", () => {
    it("does not claim a still-connected environment is restarting", () => {
      // The window is armed before dispatch, while the old server is still
      // connected. Gating on availability is what keeps that from showing the
      // restarting banner the instant the user clicks — and what makes a
      // window outliving its restart harmless.
      expect(isServerRestarting({ restartExpected: true, environmentUnavailable: false })).toBe(
        false,
      );
    });

    it("presents an armed window with an away environment as restarting", () => {
      expect(isServerRestarting({ restartExpected: true, environmentUnavailable: true })).toBe(
        true,
      );
    });

    it("falls back to the outage UI once the window lapses", () => {
      // The server never came back; the calm banner must give way.
      expect(isServerRestarting({ restartExpected: false, environmentUnavailable: true })).toBe(
        false,
      );
    });

    it("does not dress up an unrelated outage as a restart once cleared", () => {
      // The consumer clears the window after seeing the restart through, so a
      // later ordinary outage inside the original 90s must read as an outage.
      expectServerRestart(ENVIRONMENT_ID);
      clearExpectedServerRestart(ENVIRONMENT_ID);
      vi.advanceTimersByTime(10_000);

      expect(expiresAtFor(ENVIRONMENT_ID)).toBeNull();
      expect(
        isServerRestarting({
          restartExpected: expiresAtFor(ENVIRONMENT_ID) !== null,
          environmentUnavailable: true,
        }),
      ).toBe(false);
    });
  });

  describe("isExpectedRestartResolved", () => {
    const base = {
      sawRestartWindow: true,
      restartExpected: true,
      wentAway: false,
      environmentUnavailable: false,
    };

    it("does not resolve while the environment is still away", () => {
      expect(
        isExpectedRestartResolved({ ...base, wentAway: true, environmentUnavailable: true }),
      ).toBe(false);
    });

    it("resolves once the environment comes back after going away", () => {
      // Something restarted but the skew is still here, so whatever came back
      // did not carry the new version.
      expect(isExpectedRestartResolved({ ...base, wentAway: true })).toBe(true);
    });

    it("resolves when the window lapses without the connection ever dropping", () => {
      // systemd refused the restart and rolled back: the RPC already returned
      // success, so nothing else can release the action.
      expect(isExpectedRestartResolved({ ...base, restartExpected: false })).toBe(true);
    });

    it("does not resolve while the restart is still expected", () => {
      expect(isExpectedRestartResolved(base)).toBe(false);
    });

    it("does not resolve before a window has been observed", () => {
      // Guards the render between the click and the store update landing,
      // which would otherwise look like an already-lapsed window.
      expect(
        isExpectedRestartResolved({ ...base, sawRestartWindow: false, restartExpected: false }),
      ).toBe(false);
    });
  });
});
