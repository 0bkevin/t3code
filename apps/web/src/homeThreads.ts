import type { ServerProvider, ThreadId } from "@t3tools/contracts";

/**
 * Whether a thread is some instance's designated Home channel.
 *
 * Read off the streamed provider snapshots rather than off the thread itself:
 * the designation lives in the instance's settings blob, is re-emitted on
 * every status tick, and a thread row carries no flag of its own. A thread
 * that is Home for *any* instance is Home — instances cannot share one.
 */
export function isHomeThreadId(
  providers: ReadonlyArray<Pick<ServerProvider, "homeThreadId">>,
  threadId: ThreadId | string | null | undefined,
): boolean {
  if (!threadId) return false;
  return providers.some((provider) => provider.homeThreadId === threadId);
}

/**
 * Composer placeholder for a Home thread.
 *
 * Home is the agent's own channel rather than a workspace thread, and naming
 * the agent is the cue for that: the box you type in is addressed to a
 * specific process, not to whatever provider the picker happens to hold.
 * Falls back to a bare "Message Hermes" when the instance snapshot has not
 * streamed yet, which is preferable to a flash of the generic prompt.
 */
export function homeThreadComposerPlaceholder(displayName: string | undefined): string {
  const trimmed = displayName?.trim();
  return trimmed ? `Message ${trimmed}` : "Message Hermes";
}
