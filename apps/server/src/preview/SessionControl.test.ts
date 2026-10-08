import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { BrowserControlInterrupted, SessionControl } from "./SessionControl.ts";

const noop = async () => {};

describe("SessionControl", () => {
  afterEach(() => vi.useRealTimers());

  it("returns an action result before tracked navigation but drains it before already queued actions", async () => {
    const control = new SessionControl("agent");
    const committed = Promise.withResolvers<void>();
    const events: string[] = [];
    const navigation = control.agent("agent", async () => {
      control.track(committed.promise.then(() => events.push("navigation committed")));
      return "started";
    });
    const next = control.agent("agent", async () => events.push("next action"));
    await expect(navigation).resolves.toBe("started");
    expect(events).toEqual([]);
    committed.resolve();
    await next;
    expect(events).toEqual(["navigation committed", "next action"]);
  });

  it("handles tracked navigation failures without poisoning the next action", async () => {
    const control = new SessionControl("agent");
    const committed = Promise.withResolvers<void>();
    await control.agent("agent", async () => control.track(committed.promise));
    committed.reject(new Error("navigation failed"));
    await expect(control.agent("agent", async () => "resumed")).resolves.toBe("resumed");
  });

  it("only lets the assigned agent act and restores that agent after human control", async () => {
    const control = new SessionControl("agent-a");
    await expect(control.agent("agent-b", async () => "wrong agent")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    await expect(control.agent("agent-a", async () => "first")).resolves.toBe("first");
    await control.take("viewer-a");
    await expect(control.agent("agent-a", async () => "racing")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    await expect(control.human("viewer-a", async () => "typed")).resolves.toBe("typed");
    await control.release("viewer-a");
    await expect(control.agent("agent-a", async () => "resumed")).resolves.toBe("resumed");
    await expect(control.agent("agent-b", async () => "wrong agent")).rejects.toThrow(
      BrowserControlInterrupted,
    );
  });

  it("drains running work before takeover and cancels previously queued agent actions", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    const running = control.agent("agent", async () => {
      events.push("agent started");
      started.resolve();
      await finish.promise;
      events.push("agent finished");
    });
    await started.promise;
    const queued = expect(
      control.agent("agent", async () => events.push("stale agent action")),
    ).rejects.toThrow(BrowserControlInterrupted);
    const takeover = control.take("viewer");
    const typing = control.human("viewer", async () => events.push("human typed"));
    await expect(control.agent("agent", async () => "late action")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    expect(events).toEqual(["agent started"]);
    finish.resolve();
    await Promise.all([running, queued, takeover, typing]);
    expect(events).toEqual(["agent started", "agent finished", "human typed"]);
  });

  it("does not let a second viewer steal, type, release, or disconnect the owner", async () => {
    const control = new SessionControl("agent");
    const takeover = control.take("viewer-a");
    await expect(control.take("viewer-b")).rejects.toThrow("Another viewer");
    await takeover;
    await expect(control.human("viewer-b", async () => "wrong viewer")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    await expect(control.release("viewer-b")).rejects.toThrow("Only the controlling viewer");
    await control.disconnect("viewer-b");
    expect(control.controller).toBe("viewer-a");
    await expect(control.human("viewer-a", async () => "still controlled")).resolves.toBe(
      "still controlled",
    );
  });

  it("automatically claims intentional input, drains the agent, and returns after inactivity", async () => {
    vi.useFakeTimers();
    let invalidations = 0;
    const control = new SessionControl("agent", () => invalidations++);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    const running = control.agent("agent", async () => {
      events.push("agent started");
      started.resolve();
      await finish.promise;
      events.push("agent finished");
    });
    await started.promise;

    const stale = vi.fn(async () => {});
    const rejected = expect(control.agent("agent", stale)).rejects.toThrow(
      BrowserControlInterrupted,
    );
    const cleanup = vi.fn(async () => {
      events.push("input released");
    });
    const released = vi.fn();
    const gesture = control.automaticHuman(
      "viewer-a",
      async () => events.push("human gesture"),
      cleanup,
      released,
    );
    expect(control.controller).toBe("viewer-a");
    await expect(control.take("viewer-b")).rejects.toThrow("Another viewer");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(control.controller).toBe("viewer-a");
    expect(events).toEqual(["agent started"]);
    finish.resolve();
    await Promise.all([running, rejected, gesture]);
    expect(stale).not.toHaveBeenCalled();
    expect(events).toEqual(["agent started", "agent finished", "human gesture"]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(control.controller).toBe("viewer-a");
    expect(released).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(control.controller).toBeNull();
    expect(invalidations).toBe(2);
    expect(released).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(events).toEqual(["agent started", "agent finished", "human gesture", "input released"]);
    await control.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps explicit takeover indefinite after automatic control", async () => {
    vi.useFakeTimers();
    const control = new SessionControl("agent");
    await control.automaticHuman("viewer", async () => "gesture", noop, noop);
    await control.take("viewer");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(control.controller).toBe("viewer");
    await control.close();
  });

  it("renews the automatic lease and drains input cleanup before the agent resumes", async () => {
    vi.useFakeTimers();
    const control = new SessionControl("agent");
    const drained = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanup = async () => {
      cleanupStarted.resolve();
      await drained.promise;
    };
    const gesture = () => control.automaticHuman("viewer", noop, cleanup, noop);
    await gesture();
    await vi.advanceTimersByTimeAsync(4_000);
    await gesture();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(control.controller).toBe("viewer");
    await vi.advanceTimersByTimeAsync(1);
    await cleanupStarted.promise;
    expect(control.controller).toBeNull();
    const act = vi.fn(async () => "resumed");
    const resumed = control.agent("agent", act);
    expect(act).not.toHaveBeenCalled();
    drained.resolve();
    await expect(resumed).resolves.toBe("resumed");
    await control.close();
  });

  it("cancels the automatic lease on disconnect and releases a failed first gesture", async () => {
    vi.useFakeTimers();
    const control = new SessionControl("agent");
    const idleRelease = vi.fn();
    const cleanup = vi.fn(async () => {});
    await control.automaticHuman("viewer", noop, cleanup, idleRelease);
    await control.disconnect("viewer", cleanup);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(idleRelease).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(
      control.automaticHuman(
        "reconnected",
        async () => {
          throw new Error("input failed");
        },
        cleanup,
        idleRelease,
      ),
    ).rejects.toThrow("input failed");
    expect(control.controller).toBeNull();
    await expect(control.agent("agent", async () => "resumed")).resolves.toBe("resumed");
    await control.close();
  });

  it("a late dialog reply from a released lease cannot suppress the next viewer's idle release", async () => {
    vi.useFakeTimers();
    const control = new SessionControl("agent");
    const answered = Promise.withResolvers<void>();
    const oldReply = control.automaticHuman("viewer-a", () => answered.promise, noop, noop, true);
    await control.release("viewer-a");
    await control.automaticHuman("viewer-b", noop, noop, noop);
    expect(control.controller).toBe("viewer-b");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(control.controller).toBeNull();
    answered.resolve();
    await oldReply;
    expect(vi.getTimerCount()).toBe(0);
    await control.close();
  });

  it("invalidates queued human actions and refs when a viewer disconnects", async () => {
    let invalidations = 0;
    const control = new SessionControl("agent", () => invalidations++);
    await control.take("viewer");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    const running = control.human("viewer", async () => {
      started.resolve();
      await finish.promise;
      events.push("human finished");
    });
    await started.promise;
    const queued = expect(
      control.human("viewer", async () => events.push("stale human action")),
    ).rejects.toThrow(BrowserControlInterrupted);
    const disconnected = control.disconnect("viewer");
    const resumed = control.agent("agent", async () => events.push("agent resumed"));
    expect(control.generation).toBe(2);
    expect(invalidations).toBe(2);
    finish.resolve();
    await Promise.all([running, queued, disconnected, resumed]);
    expect(events).toEqual(["human finished", "agent resumed"]);
  });

  it("does not revive stale actions when takeover is released before running work finishes", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = control.agent("agent", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const staleAgent = expect(control.agent("agent", async () => "stale")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    const takeover = expect(control.take("viewer")).rejects.toThrow(BrowserControlInterrupted);
    const staleHuman = expect(control.human("viewer", async () => "stale")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    const release = control.release("viewer");
    const resumed = control.agent("agent", async () => "fresh");
    finish.resolve();
    await Promise.all([running, staleAgent, takeover, staleHuman, release]);
    await expect(resumed).resolves.toBe("fresh");
  });

  it("closes after running work finishes and never runs queued or new actions", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = control.agent("agent", async () => {
      started.resolve();
      await finish.promise;
      return "finished";
    });
    await started.promise;
    const queued = expect(control.agent("agent", async () => "stale")).rejects.toThrow("closed");
    const closed = control.close();
    await expect(control.take("viewer")).rejects.toThrow("closed");
    await expect(control.agent("agent", async () => "new")).rejects.toThrow("closed");
    finish.resolve();
    await expect(running).resolves.toBe("finished");
    await Promise.all([queued, closed]);
    await control.disconnect("viewer");
    await control.close();
    expect(control.generation).toBe(1);
  });

  it("does not let a failed action poison the serial queue", async () => {
    const control = new SessionControl("agent");
    await expect(
      control.agent("agent", async () => {
        throw new Error("navigation failed");
      }),
    ).rejects.toThrow("navigation failed");
    await expect(control.agent("agent", async () => "recovered")).resolves.toBe("recovered");
  });
});
