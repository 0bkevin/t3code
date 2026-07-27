/**
 * Honest, metadata-only descriptions of what conversation context a task tab
 * has. Tabs in one workspace task share a project/worktree/branch but never a
 * live conversation, so the copy here must never imply synced history:
 * - Main and any started tab own their transcript outright.
 * - A fresh tab is literally empty until its first message.
 * - A portable fork receives one bounded snapshot of its source tab on the
 *   first provider call, then continues on its own.
 *
 * Nothing here counts messages or tokens — only shape is known client-side.
 */

export type TaskTabContextKind = "main" | "empty" | "own" | "snapshot";

export interface TaskTabContextSource {
  /** Server tabs have a real thread; drafts have not sent a message yet. */
  readonly kind: "server" | "draft";
  readonly threadId: string;
  readonly title: string;
  readonly position: number;
  readonly forkProvenance: {
    readonly mode: "fresh" | "portable";
    readonly sourceThreadId: string | null;
  } | null;
}

export interface TaskTabContextDescriptor {
  readonly kind: TaskTabContextKind;
  /** Tab name as rendered in the strip. */
  readonly title: string;
  /** Short inline label, e.g. "From Main". */
  readonly label: string;
  /** One sentence expanding the label, for tooltips. */
  readonly detail: string;
  /** Resolved sibling tab title for portable forks, when still present. */
  readonly sourceTitle: string | null;
}

const FALLBACK_SOURCE_TITLE = "other tab";

/**
 * Mirrors the legacy strip fallback: the first tab reads as "Main" even when a
 * draft was persisted before tab labels existed.
 */
export function taskTabDisplayTitle(tab: TaskTabContextSource): string {
  if (tab.position === 0 && (tab.title === "Tab 1" || tab.title.trim() === "")) return "Main";
  return tab.title;
}

function describeOne(
  tab: TaskTabContextSource,
  sourceTitle: string | null,
): TaskTabContextDescriptor {
  const title = taskTabDisplayTitle(tab);
  const base = { title, sourceTitle } as const;

  if (tab.forkProvenance?.mode === "portable") {
    const from = sourceTitle ?? FALLBACK_SOURCE_TITLE;
    return {
      ...base,
      kind: "snapshot",
      label: `From ${from}`,
      detail:
        tab.kind === "draft"
          ? `Copies ${from} once on send.`
          : `Started from ${from}; now independent.`,
    };
  }

  if (tab.kind === "draft") {
    return {
      ...base,
      kind: "empty",
      label: "Empty",
      detail: "No chat history.",
    };
  }

  if (tab.position === 0) {
    return {
      ...base,
      kind: "main",
      label: "Independent",
      detail: "Separate chat history.",
    };
  }

  return {
    ...base,
    kind: "own",
    label: "Independent",
    detail: "Separate chat history.",
  };
}

/**
 * Describes every tab in one pass so a portable fork can name its source by
 * the label that source currently shows in the strip. A source that was closed
 * (or lives outside this task) degrades to "another tab" rather than leaking a
 * thread id.
 */
export function describeTaskTabContexts(
  tabs: ReadonlyArray<TaskTabContextSource>,
): ReadonlyArray<TaskTabContextDescriptor> {
  const titleByThreadId = new Map(tabs.map((tab) => [tab.threadId, taskTabDisplayTitle(tab)]));
  return tabs.map((tab) => {
    const sourceThreadId = tab.forkProvenance?.sourceThreadId ?? null;
    const sourceTitle =
      sourceThreadId !== null && sourceThreadId !== tab.threadId
        ? (titleByThreadId.get(sourceThreadId) ?? null)
        : null;
    return describeOne(tab, sourceTitle);
  });
}
