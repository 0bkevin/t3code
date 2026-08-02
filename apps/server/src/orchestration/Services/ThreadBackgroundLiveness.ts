/**
 * ThreadBackgroundLivenessService - In-memory per-thread background liveness
 * for the sidebar status pill.
 *
 * The turn can settle while native background work runs on (subagent fleets,
 * workflow runs, Monitor watch loops); the shell previously showed nothing.
 * Ingestion records task lifecycle transitions and the shell query reads the
 * derived state at mapping time — no persistence, no migration. After a
 * server restart the registry is empty until new task events arrive, which
 * matches reality: orphaned background work is not live.
 *
 * @module ThreadBackgroundLivenessService
 */
import * as Context from "effect/Context";

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

export interface ThreadBackgroundLivenessShape {
  /**
   * Feed one task lifecycle transition. taskType may be absent on
   * synthesized rows (workflow members, Codex children) — those count as
   * agents. agentId marks a subagent's internal work, which the owning
   * agent's liveness already covers.
   */
  readonly recordTaskLiveness: (input: {
    readonly threadId: string;
    readonly taskId: string;
    readonly taskType: string | undefined;
    readonly status: string | undefined;
    readonly kind: "started" | "progress" | "updated" | "completed";
    readonly agentId?: string | undefined;
  }) => void;

  /** Session death orphans all of a thread's background work. */
  readonly clearThreadLiveness: (threadId: string) => void;

  /**
   * Two-state vocabulary by design: any live agent work is "working";
   * "monitoring" only when watch loops are the ONLY live work.
   */
  readonly getThreadBackgroundLiveness: (threadId: string) => ThreadBackgroundLiveness;
}

export class ThreadBackgroundLivenessService extends Context.Service<
  ThreadBackgroundLivenessService,
  ThreadBackgroundLivenessShape
>()("t3/orchestration/Services/ThreadBackgroundLiveness/ThreadBackgroundLivenessService") {}
