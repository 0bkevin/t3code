import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { WorkspaceTaskId } from "@t3tools/contracts";

export interface WorkspaceTaskGroup {
  readonly id: WorkspaceTaskId;
  readonly key: string;
  readonly tabs: ReadonlyArray<EnvironmentThreadShell>;
  readonly root: EnvironmentThreadShell;
}

export function resolveWorkspaceTaskId(
  thread: Pick<EnvironmentThreadShell, "id" | "workspaceTaskId">,
): WorkspaceTaskId {
  return thread.workspaceTaskId ?? WorkspaceTaskId.make(String(thread.id));
}

export function workspaceTaskKey(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "workspaceTaskId">,
): string {
  return `${thread.environmentId}:${resolveWorkspaceTaskId(thread)}`;
}

export function groupThreadsByWorkspaceTask(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<WorkspaceTaskGroup> {
  const grouped = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    const key = workspaceTaskKey(thread);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      grouped.set(key, [thread]);
    }
  }

  return [...grouped.entries()].map(([key, unsortedTabs]) => {
    const tabs = unsortedTabs.toSorted(
      (left, right) =>
        (left.tabPosition ?? 0) - (right.tabPosition ?? 0) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
    return {
      id: resolveWorkspaceTaskId(tabs[0]!),
      key,
      tabs,
      root: tabs[0]!,
    };
  });
}

function representativePriority(thread: EnvironmentThreadShell): number {
  if (thread.hasPendingApprovals) return 5;
  if (thread.hasPendingUserInput) return 4;
  if (thread.session?.status === "error") return 3;
  if (thread.session?.status === "running" || thread.session?.status === "starting") return 2;
  return 1;
}

export function taskPresentationThread(
  task: WorkspaceTaskGroup,
  activeThreadKey: string | null,
): EnvironmentThreadShell {
  const activeTab =
    activeThreadKey === null
      ? null
      : (task.tabs.find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
        ) ?? null);
  const representative = [...task.tabs].toSorted(
    (left, right) =>
      representativePriority(right) - representativePriority(left) ||
      right.updatedAt.localeCompare(left.updatedAt),
  )[0]!;
  const source =
    activeTab && representativePriority(activeTab) >= representativePriority(representative)
      ? activeTab
      : representative;
  const updatedAt = task.tabs.reduce(
    (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
    task.root.updatedAt,
  );
  const latestUserMessageAt = task.tabs.reduce<string | null>(
    (latest, thread) =>
      thread.latestUserMessageAt !== null &&
      (latest === null || thread.latestUserMessageAt > latest)
        ? thread.latestUserMessageAt
        : latest,
    null,
  );

  return {
    ...source,
    // Task title and workspace identity are owned by the root tab. Status and
    // recency are aggregated from every sibling tab.
    id: task.root.id,
    environmentId: task.root.environmentId,
    title: task.root.title,
    projectId: task.root.projectId,
    branch: task.root.branch,
    worktreePath: task.root.worktreePath,
    workspaceTaskId: task.id,
    tabLabel: null,
    tabPosition: 0,
    updatedAt,
    latestUserMessageAt,
    hasPendingApprovals: task.tabs.some((thread) => thread.hasPendingApprovals),
    hasPendingUserInput: task.tabs.some((thread) => thread.hasPendingUserInput),
    hasActionableProposedPlan: task.tabs.some((thread) => thread.hasActionableProposedPlan),
  };
}

export function workspaceTaskTabCountByThread(
  tasks: ReadonlyArray<WorkspaceTaskGroup>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    for (const thread of task.tabs) {
      counts.set(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        task.tabs.length,
      );
    }
  }
  return counts;
}
