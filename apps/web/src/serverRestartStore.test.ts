import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  SERVER_RESTART_EXPECTED_WINDOW_MS,
  clearExpectedServerRestart,
  expectServerRestart,
  isServerRestartSettled,
  isServerRestarting,
  markServerRestartDisconnected,
  useServerRestartStore,
} from "./serverRestartStore";

const ENVIRONMENT_ID = "env-test" as EnvironmentId;

function windowFor(environmentId: EnvironmentId) {
  return useServerRestartStore.getState().windowByEnvironmentId[environmentId] ?? null;
}

describe("serverRestartStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useServerRestartStore.setState({ windowByEnvironmentId: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms a window that has not yet seen the restart's disconnect", () => {
    expectServerRestart(ENVIRONMENT_ID);

    // The window is armed while the old server is still connected, so the
    // consumer must be able to tell "waiting for the restart" apart from
    // "the restart already happened".
    expect(windowFor(ENVIRONMENT_ID)?.sawDisconnect).toBe(false);
    expect(windowFor(ENVIRONMENT_ID)?.expiresAt).toBe(
      Date.now() + SERVER_RESTART_EXPECTED_WINDOW_MS,
    );
  });

  it("remembers an observed disconnect across a re-arm", () => {
    expectServerRestart(ENVIRONMENT_ID);
    markServerRestartDisconnected(ENVIRONMENT_ID);

    // A slow install acknowledging late re-arms the window; forgetting the
    // disconnect here would strand the restarting UI until the window lapsed.
    vi.advanceTimersByTime(30_000);
    expectServerRestart(ENVIRONMENT_ID);

    expect(windowFor(ENVIRONMENT_ID)?.sawDisconnect).toBe(true);
    expect(windowFor(ENVIRONMENT_ID)?.expiresAt).toBe(
      Date.now() + SERVER_RESTART_EXPECTED_WINDOW_MS,
    );
  });

  it("ignores a disconnect for an environment with no armed window", () => {
    markServerRestartDisconnected(ENVIRONMENT_ID);
    expect(windowFor(ENVIRONMENT_ID)).toBeNull();
  });

  it("clears only the requested environment", () => {
    const other = "env-other" as EnvironmentId;
    expectServerRestart(ENVIRONMENT_ID);
    expectServerRestart(other);

    clearExpectedServerRestart(ENVIRONMENT_ID);

    expect(windowFor(ENVIRONMENT_ID)).toBeNull();
    expect(windowFor(other)).not.toBeNull();
  });

  describe("isServerRestarting", () => {
    it("does not claim a still-connected environment is restarting", () => {
      // The window is armed before dispatch, while the old server is still
      // connected. Presenting that as "restarting" would fire the moment the
      // user clicks, before anything has actually gone away.
      expect(
        isServerRestarting({
          expectation: { expected: true, sawDisconnect: false },
          environmentUnavailable: false,
        }),
      ).toBe(false);
    });

    it("presents an armed window with an away environment as restarting", () => {
      expect(
        isServerRestarting({
          expectation: { expected: true, sawDisconnect: true },
          environmentUnavailable: true,
        }),
      ).toBe(true);
    });

    it("falls back to the outage UI once the window lapses", () => {
      // The server never came back; the calm banner must give way.
      expect(
        isServerRestarting({
          expectation: { expected: false, sawDisconnect: true },
          environmentUnavailable: true,
        }),
      ).toBe(false);
    });
  });

  describe("isServerRestartSettled", () => {
    it("does not treat a live window as settled", () => {
      expect(isServerRestartSettled({ expected: true, sawDisconnect: true })).toBe(false);
    });

    it("treats an observed restart whose window has closed as settled", () => {
      // Covers a rejected systemd restart: the RPC already acknowledged, so
      // nothing else can tell the update action to release itself.
      expect(isServerRestartSettled({ expected: false, sawDisconnect: true })).toBe(true);
    });

    it("does not settle a window that never saw a disconnect", () => {
      // The restart simply never happened; the explicit-failure path owns
      // that case, and settling here would release the action early.
      expect(isServerRestartSettled({ expected: false, sawDisconnect: false })).toBe(false);
    });
  });
});
