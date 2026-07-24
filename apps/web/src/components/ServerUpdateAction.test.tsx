import type { Dispatch, ReactElement, SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  SERVER_SELF_UPDATE_ALREADY_RUNNING_REASON,
  ServerSelfUpdateError,
  type EnvironmentId,
} from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
}));

const restartStore = vi.hoisted(() => ({
  expect: vi.fn(),
  clear: vi.fn(),
  expectation: vi.fn(() => ({ expected: false, sawDisconnect: false })),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useEffect() {
      nextIndex();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateServer: Symbol("updateServer") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateServer,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toast },
}));
vi.mock("~/serverRestartStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/serverRestartStore")>();
  return {
    ...actual,
    expectServerRestart: restartStore.expect,
    clearExpectedServerRestart: restartStore.clear,
    useServerRestartExpectation: restartStore.expectation,
  };
});

import { ServerUpdateAction } from "./ServerUpdateAction";

type ActionElement = ReactElement<{
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}>;

function renderAction(): ActionElement {
  hooks.beginRender();
  return ServerUpdateAction({
    environmentId: "env-test" as EnvironmentId,
    serverLabel: "Test server",
    selfUpdate: "boot-service",
    targetVersion: "0.0.29",
  }) as ActionElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ServerUpdateAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.reset();
    testState.updateServer.mockReset();
    testState.toast.mockReset();
    restartStore.expect.mockReset();
    restartStore.clear.mockReset();
    restartStore.expectation.mockReset();
    restartStore.expectation.mockReturnValue({ expected: false, sawDisconnect: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a fresh reconnect timeout after a long install succeeds", async () => {
    const update =
      deferred<
        ReturnType<typeof AsyncResult.success<{ targetVersion: string; method: "boot-service" }>>
      >();
    testState.updateServer.mockReturnValue(update.promise);

    renderAction().props.onClick?.();
    expect(renderAction().props.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    update.resolve(
      AsyncResult.success({
        targetVersion: "0.0.29",
        method: "boot-service",
      }),
    );
    await flushPromises();

    // The click-based deadline would have fired by now. Success gets a fresh
    // twelve-minute reconnect window, so the action remains disabled.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(renderAction().props.disabled).toBe(true);
    expect(testState.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Server update timed out" }),
    );

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(renderAction().props.disabled).not.toBe(true);
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Server update timed out" }),
    );
  });

  it("does not let an expired request clear a newer retry", async () => {
    const first = deferred<ReturnType<typeof AsyncResult.failure>>();
    const retry =
      deferred<
        ReturnType<typeof AsyncResult.success<{ targetVersion: string; method: "boot-service" }>>
      >();
    testState.updateServer.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);

    renderAction().props.onClick?.();
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(renderAction().props.disabled).not.toBe(true);

    renderAction().props.onClick?.();
    expect(renderAction().props.disabled).toBe(true);

    first.resolve(AsyncResult.failure(Cause.fail(new Error("first request failed late"))));
    await flushPromises();

    expect(renderAction().props.disabled).toBe(true);
    expect(testState.updateServer).toHaveBeenCalledTimes(2);

    retry.resolve(AsyncResult.success({ targetVersion: "0.0.29", method: "boot-service" }));
    await flushPromises();
    expect(renderAction().props.disabled).toBe(true);
  });

  it("quietly releases the action when a restart RPC is interrupted", async () => {
    testState.updateServer.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    renderAction().props.onClick?.();
    await flushPromises();

    expect(renderAction().props.disabled).not.toBe(true);
    expect(testState.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Server update failed" }),
    );
  });

  it("re-arms the restart window when a slow install finally succeeds", async () => {
    const update =
      deferred<
        ReturnType<typeof AsyncResult.success<{ targetVersion: string; method: "boot-service" }>>
      >();
    testState.updateServer.mockReturnValue(update.promise);

    renderAction().props.onClick?.();
    expect(restartStore.expect).toHaveBeenCalledTimes(1);

    // An install can outlast the 90s restart window armed at click time, so
    // the acknowledgement must restart the clock or the ensuing disconnect
    // would be presented as an outage.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    update.resolve(AsyncResult.success({ targetVersion: "0.0.29", method: "boot-service" }));
    await flushPromises();

    expect(restartStore.expect).toHaveBeenCalledTimes(2);
    expect(restartStore.clear).not.toHaveBeenCalled();
  });

  it("re-arms the restart window on an interrupted restart RPC", async () => {
    testState.updateServer.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    renderAction().props.onClick?.();
    await flushPromises();

    expect(restartStore.expect).toHaveBeenCalledTimes(2);
    expect(restartStore.clear).not.toHaveBeenCalled();
  });

  it("withdraws the restart expectation when the server reports a real failure", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new ServerSelfUpdateError({ reason: "Could not install the requested t3 version." }),
        ),
      ),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    // The server answered, so it is still alive and no restart is coming.
    expect(restartStore.clear).toHaveBeenCalledTimes(1);
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Server update failed" }),
    );
  });

  it("keeps the restart expectation when an update is already in progress", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new ServerSelfUpdateError({ reason: SERVER_SELF_UPDATE_ALREADY_RUNNING_REASON }),
        ),
      ),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    // An earlier request is still installing, so a restart really is pending
    // — clearing here would restore the harsh reconnect UI mid-restart.
    expect(restartStore.clear).not.toHaveBeenCalled();
  });
});
