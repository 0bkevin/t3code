/**
 * ThreadBackgroundLivenessLive - synchronous in-memory implementation of the
 * background-liveness registry. State is allocated per layer instance, so
 * tests can construct isolated registries.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ThreadBackgroundLivenessService,
  type ThreadBackgroundLivenessShape,
} from "../Services/ThreadBackgroundLiveness.ts";

interface ThreadLivenessState {
  readonly agents: Set<string>;
  readonly monitors: Set<string>;
}

/**
 * Watch-loop bucket. Monitor-tool tasks, plus background shells: a shell
 * that outlives its turn is in practice a watch loop (PR babysitting, log
 * tails) — pacing sleeps complete inside the turn, where the session-running
 * check already presents Working, so they never surface from here.
 */
const MONITOR_TASK_TYPES: ReadonlySet<string> = new Set([
  "monitor",
  "monitor_mcp",
  "local_bash",
  "shell",
]);
/** Task types that are neither agents nor monitors (never affect liveness). */
const INERT_TASK_TYPES: ReadonlySet<string> = new Set(["plan"]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

export function makeThreadBackgroundLiveness(): ThreadBackgroundLivenessShape {
  const stateByThreadId = new Map<string, ThreadLivenessState>();

  const stateFor = (threadId: string): ThreadLivenessState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created: ThreadLivenessState = { agents: new Set(), monitors: new Set() };
    stateByThreadId.set(threadId, created);
    return created;
  };

  return {
    recordTaskLiveness: (input) => {
      const taskType = input.taskType;
      if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
        return;
      }
      // A subagent's internal task (its own shells) is covered by the
      // agent's liveness; counting it separately would keep threads
      // Monitoring/Working after the agent itself settled.
      if (input.agentId !== undefined) {
        return;
      }
      const state = stateFor(input.threadId);

      // Idle counts as not-live: a resting (resumable) Codex child isn't
      // doing anything, and an all-idle fleet must not pin Working.
      const terminal =
        input.kind === "completed" ||
        input.status === "idle" ||
        (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
      if (terminal) {
        // Terminal rows may omit taskType (review finding): classification
        // is unreliable at removal time, so clear from both buckets.
        state.agents.delete(input.taskId);
        state.monitors.delete(input.taskId);
      } else {
        const bucket =
          taskType !== undefined && MONITOR_TASK_TYPES.has(taskType)
            ? state.monitors
            : state.agents;
        bucket.add(input.taskId);
      }
      if (state.agents.size === 0 && state.monitors.size === 0) {
        stateByThreadId.delete(input.threadId);
      }
    },

    clearThreadLiveness: (threadId) => {
      stateByThreadId.delete(threadId);
    },

    getThreadBackgroundLiveness: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) {
        return null;
      }
      if (state.agents.size > 0) {
        return "working";
      }
      if (state.monitors.size > 0) {
        return "monitoring";
      }
      return null;
    },
  };
}

export const ThreadBackgroundLivenessLive = Layer.effect(
  ThreadBackgroundLivenessService,
  Effect.sync(makeThreadBackgroundLiveness),
);
