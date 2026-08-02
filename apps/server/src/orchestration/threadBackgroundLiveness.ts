/**
 * In-memory per-thread background liveness for the sidebar status pill.
 *
 * The turn can settle while native background work runs on (subagent fleets,
 * workflow runs, Monitor watch loops); the shell previously showed nothing.
 * Ingestion updates this registry from the task lifecycle it already
 * processes, and the shell query reads it at mapping time — no migration and
 * no new persisted state. Zero-migration trade-off: the registry is empty
 * after a server restart until new task events arrive; agents orphaned by a
 * restart read as not-live, matching their real state.
 *
 * "monitoring" is reserved for watch loops (Monitor tool tasks): a thread
 * whose parent agent is babysitting a PR or tailing a log. Agent/workflow
 * work presents as plain "working" alongside turn activity.
 */

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

interface ThreadLivenessState {
  readonly agents: Set<string>;
  readonly monitors: Set<string>;
}

const stateByThreadId = new Map<string, ThreadLivenessState>();

/**
 * Watch-loop bucket. Monitor-tool tasks, plus background shells: a shell
 * that outlives its turn is in practice a watch loop (PR babysitting, log
 * tails) — pacing sleeps complete inside the turn, where the session-running
 * check already presents Working, so they never surface from here.
 */
const MONITOR_TASK_TYPES: ReadonlySet<string> = new Set(["monitor", "local_bash", "shell"]);
/** Task types that are neither agents nor monitors (never affect liveness). */
const INERT_TASK_TYPES: ReadonlySet<string> = new Set(["plan"]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

function stateFor(threadId: string): ThreadLivenessState {
  const existing = stateByThreadId.get(threadId);
  if (existing) {
    return existing;
  }
  const created: ThreadLivenessState = { agents: new Set(), monitors: new Set() };
  stateByThreadId.set(threadId, created);
  return created;
}

/**
 * Feed one task lifecycle transition. taskType may be absent on synthesized
 * rows (workflow members, Codex children) — those count as agents. Shells
 * (local_bash) are excluded: a background command is not fleet work.
 */
export function recordTaskLiveness(input: {
  readonly threadId: string;
  readonly taskId: string;
  readonly taskType: string | undefined;
  readonly status: string | undefined;
  readonly kind: "started" | "progress" | "updated" | "completed";
  /** Present when the task is a subagent's internal work. */
  readonly agentId?: string | undefined;
}): void {
  const taskType = input.taskType;
  if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
    return;
  }
  // A subagent's internal task (its own shells) is covered by the agent's
  // liveness; counting it separately would keep threads Monitoring/Working
  // after the agent itself settled.
  if (input.agentId !== undefined) {
    return;
  }
  const state = stateFor(input.threadId);
  const bucket =
    taskType !== undefined && MONITOR_TASK_TYPES.has(taskType) ? state.monitors : state.agents;

  // Idle counts as not-live: a resting (resumable) Codex child isn't doing
  // anything, and an all-idle fleet must not pin the thread at Working.
  const terminal =
    input.kind === "completed" ||
    input.status === "idle" ||
    (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
  if (terminal) {
    bucket.delete(input.taskId);
  } else {
    bucket.add(input.taskId);
  }
  if (state.agents.size === 0 && state.monitors.size === 0) {
    stateByThreadId.delete(input.threadId);
  }
}

/** Session death orphans all of a thread's background work. */
export function clearThreadLiveness(threadId: string): void {
  stateByThreadId.delete(threadId);
}

/**
 * The pill vocabulary is deliberately two-state: any live agent work is
 * "working"; "monitoring" only when watch loops are the ONLY live work.
 */
export function getThreadBackgroundLiveness(threadId: string): ThreadBackgroundLiveness {
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
}
