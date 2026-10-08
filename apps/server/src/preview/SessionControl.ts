// @effect-diagnostics globalTimers:off - Session ownership is shared with Promise-based browser callbacks.
import type { PreviewAutomationControlReason } from "@t3tools/contracts";

const AUTOMATIC_CONTROL_IDLE_MS = 5_000;

export class BrowserControlInterrupted extends Error {
  readonly reason: PreviewAutomationControlReason;
  constructor(
    message = "Browser control changed. Refresh the snapshot before trying again.",
    reason: PreviewAutomationControlReason = "interrupted",
  ) {
    super(message);
    this.reason = reason;
  }
}

/** Reserves control immediately, but drains running work before the new owner can act. */
export class SessionControl {
  readonly agentId: string | null;
  private readonly onGenerationChange: () => void;
  private tail: Promise<unknown> = Promise.resolve();
  private pending: Promise<void> = Promise.resolve();
  private owner: string | null = null;
  private epoch = 0;
  private closed = false;
  private automatic: { pending: number } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private cancelIdleRelease() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  constructor(agentId: string | null, onGenerationChange: () => void = () => {}) {
    this.agentId = agentId;
    this.onGenerationChange = onGenerationChange;
  }

  get controller() {
    return this.owner;
  }

  get generation() {
    return this.epoch;
  }

  private enqueue<A>(run: () => Promise<A>): Promise<A> {
    const result = this.tail.then(run);
    this.tail = result.then(
      () => this.pending,
      () => this.pending,
    );
    return result;
  }

  /** An action can respond before its navigation commits, while later actions still wait. */
  track(work: Promise<unknown>) {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.pending = Promise.all([this.pending, settled]).then(() => undefined);
  }

  private assertOpen() {
    if (this.closed) throw new BrowserControlInterrupted("This browser tab is closed.", "closed");
  }

  private changeOwner(owner: string | null) {
    this.cancelIdleRelease();
    this.automatic = null;
    this.owner = owner;
    this.epoch++;
    this.onGenerationChange();
  }

  private async action<A>(allowed: () => boolean, run: () => Promise<A>) {
    this.assertOpen();
    if (!allowed()) throw new BrowserControlInterrupted("You do not control this browser tab.");
    const epoch = this.epoch;
    return this.enqueue(async () => {
      this.assertOpen();
      if (epoch !== this.epoch || !allowed()) throw new BrowserControlInterrupted();
      return run();
    });
  }

  agent<A>(agentId: string, run: () => Promise<A>) {
    if (this.agentId !== agentId)
      return Promise.reject(
        new BrowserControlInterrupted("This tab belongs to another agent.", "agentMismatch"),
      );
    if (this.owner !== null)
      return Promise.reject(
        new BrowserControlInterrupted("A human controls this tab.", "humanControl"),
      );
    return this.action(() => this.agentId === agentId && this.owner === null, run);
  }

  /**
   * Work any client may ask for, such as a viewport or appearance change. It
   * waits its turn behind running actions but needs no control.
   */
  system<A>(run: () => Promise<A>) {
    this.assertOpen();
    return this.enqueue(async () => {
      this.assertOpen();
      return run();
    });
  }

  human<A>(viewerId: string, run: () => Promise<A>) {
    return this.action(() => this.owner === viewerId, run);
  }

  /** Reserve synchronously so the first gesture and its following input share one generation. */
  async automaticHuman<A>(
    viewerId: string,
    run: () => Promise<A>,
    afterDrain: () => Promise<void>,
    onRelease: () => void,
    // Dialog replies unblock running actions, so they cannot wait behind those actions.
    dialogReply = false,
  ) {
    this.assertOpen();
    if (this.owner !== null && this.owner !== viewerId)
      throw new BrowserControlInterrupted("Another viewer controls this browser tab.");
    if (this.owner === null) {
      this.changeOwner(viewerId);
      this.automatic = { pending: 0 };
    }
    const act = () => (dialogReply ? run() : this.human(viewerId, run));
    const lease = this.automatic;
    if (!lease) return act();
    this.cancelIdleRelease();
    lease.pending++;
    let delivered = false;
    try {
      const result = await act();
      delivered = true;
      return result;
    } finally {
      lease.pending--;
      if (lease.pending === 0 && this.automatic === lease) {
        // Count inactivity after delivery, including a slow takeover, rather than receipt.
        const release = () => {
          const releasing = this.release(viewerId, afterDrain);
          onRelease();
          void releasing.catch(() => undefined);
        };
        if (delivered) this.idleTimer = setTimeout(release, AUTOMATIC_CONTROL_IDLE_MS);
        else release();
      }
    }
  }

  async take(viewerId: string) {
    this.assertOpen();
    if (this.owner !== null && this.owner !== viewerId) {
      throw new BrowserControlInterrupted("Another viewer controls this browser tab.");
    }
    this.cancelIdleRelease();
    this.automatic = null;
    if (this.owner !== viewerId) this.changeOwner(viewerId);
    return this.human(viewerId, async () => {});
  }

  async release(viewerId: string, afterDrain: () => Promise<void> = async () => {}) {
    this.assertOpen();
    if (this.owner !== viewerId) {
      throw new BrowserControlInterrupted(
        "Only the controlling viewer can release this browser tab.",
      );
    }
    this.changeOwner(null);
    await this.enqueue(afterDrain);
  }

  async disconnect(viewerId: string, afterDrain?: () => Promise<void>) {
    if (!this.closed && this.owner === viewerId) await this.release(viewerId, afterDrain);
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      this.changeOwner(null);
    }
    await this.tail;
  }
}
