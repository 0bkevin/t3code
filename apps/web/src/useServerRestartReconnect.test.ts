import { describe, expect, it } from "vite-plus/test";

import {
  MAX_RETRIES_PER_WINDOW,
  restartRetryDelayMs,
  shouldPokeRestartRetry,
} from "./useServerRestartReconnect";

describe("restart reconnect pacing", () => {
  it("starts fast so a backoff sleep cannot outlast the server's return", () => {
    expect(restartRetryDelayMs(0)).toBe(2_000);
    expect(restartRetryDelayMs(1)).toBe(2_000);
  });

  it("eases off rather than polling at a fixed rate for the whole window", () => {
    const delays = [0, 1, 2, 3, 4, 5, 20].map(restartRetryDelayMs);
    // Monotonic, and flat once it reaches the ceiling.
    for (let index = 1; index < delays.length; index++) {
      expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1] ?? 0);
    }
    expect(restartRetryDelayMs(20)).toBe(8_000);
  });

  describe("shouldPokeRestartRetry", () => {
    const base = { connected: false, retryAt: 1, attempts: 0 };

    it("pokes a supervisor asleep in backoff", () => {
      expect(shouldPokeRestartRetry(base)).toBe(true);
    });

    it("does not poke a connected environment", () => {
      expect(shouldPokeRestartRetry({ ...base, connected: true })).toBe(false);
    });

    it("does not interrupt a live connection attempt", () => {
      // retryAt is null while an attempt is in flight; waking it would tear
      // the attempt down and restart it, making reconnection slower.
      expect(shouldPokeRestartRetry({ ...base, retryAt: null })).toBe(false);
    });

    it("stops once the retry budget is spent", () => {
      // The window is a duration, not a budget. Without the cap a server that
      // never returns would be retried for the window's full length, and each
      // poke rebuilds a connection attempt.
      expect(shouldPokeRestartRetry({ ...base, attempts: MAX_RETRIES_PER_WINDOW - 1 })).toBe(true);
      expect(shouldPokeRestartRetry({ ...base, attempts: MAX_RETRIES_PER_WINDOW })).toBe(false);
      expect(shouldPokeRestartRetry({ ...base, attempts: MAX_RETRIES_PER_WINDOW + 5 })).toBe(false);
    });
  });
});
