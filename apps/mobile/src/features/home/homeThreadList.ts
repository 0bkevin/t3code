import {
  deriveLogicalProjectKey,
  derivePhysicalProjectKey,
  deriveProjectGroupLabel,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  getThreadSortTimestamp,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  ScopedProjectRef,
  SidebarProjectGroupingMode,
  SidebarProjectSortOrder,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

export type HomeProjectSortOrder = Exclude<SidebarProjectSortOrder, "manual">;

export interface HomeProjectScope {
  readonly key: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
}

function getProjectFreshnessTimestamp(project: EnvironmentProject): number {
  return toSortableTimestamp(project.updatedAt) ?? toSortableTimestamp(project.createdAt) ?? 0;
}

function getProjectSortTimestamp(
  project: EnvironmentProject,
  sortOrder: HomeProjectSortOrder,
): number {
  return sortOrder === "created_at"
    ? (toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY)
    : (toSortableTimestamp(project.updatedAt) ??
        toSortableTimestamp(project.createdAt) ??
        Number.NEGATIVE_INFINITY);
}

export function buildHomeProjectScopes(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}): ReadonlyArray<HomeProjectScope> {
  const projects = input.projects.filter(
    (project) => input.environmentId === null || project.environmentId === input.environmentId,
  );
  const projectsByPhysicalKey = new Map<string, EnvironmentProject[]>();
  for (const project of projects) {
    const physicalKey = derivePhysicalProjectKey(project);
    const existing = projectsByPhysicalKey.get(physicalKey);
    if (existing) existing.push(project);
    else projectsByPhysicalKey.set(physicalKey, [project]);
  }

  const winnersByPhysicalKey = new Map<
    string,
    { readonly key: string; readonly project: EnvironmentProject }
  >();
  for (const [physicalKey, members] of projectsByPhysicalKey) {
    const project = members.reduce((winner, candidate) => {
      const freshnessDelta =
        getProjectFreshnessTimestamp(candidate) - getProjectFreshnessTimestamp(winner);
      return freshnessDelta > 0 || (freshnessDelta === 0 && candidate.id > winner.id)
        ? candidate
        : winner;
    });
    const identitySource = members.find((member) => member.repositoryIdentity !== null) ?? project;
    winnersByPhysicalKey.set(physicalKey, {
      key: deriveLogicalProjectKey(identitySource, { groupingMode: input.projectGroupingMode }),
      project,
    });
  }

  const groups = new Map<string, EnvironmentProject[]>();
  for (const { key, project } of winnersByPhysicalKey.values()) {
    const existing = groups.get(key);
    if (existing) existing.push(project);
    else groups.set(key, [project]);
  }

  const projectRefsByGroup = new Map<string, ScopedProjectRef[]>();
  const seenProjectRefs = new Set<string>();
  for (const project of projects) {
    const refKey = scopedProjectKey(project.environmentId, project.id);
    if (seenProjectRefs.has(refKey)) continue;
    seenProjectRefs.add(refKey);

    const key =
      winnersByPhysicalKey.get(derivePhysicalProjectKey(project))?.key ??
      deriveLogicalProjectKey(project, { groupingMode: input.projectGroupingMode });
    const refs = projectRefsByGroup.get(key);
    const projectRef = { environmentId: project.environmentId, projectId: project.id };
    if (refs) refs.push(projectRef);
    else projectRefsByGroup.set(key, [projectRef]);
  }

  return Array.from(groups, ([key, projects]) => {
    const representative = projects[0]!;
    return {
      key,
      title: deriveProjectGroupLabel({ representative, members: projects }),
      representative,
      projects,
      projectRefs: projectRefsByGroup.get(key) ?? [],
    };
  });
}

export function sortHomeProjectScopes(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly projectSortOrder: HomeProjectSortOrder;
}): ReadonlyArray<HomeProjectScope> {
  const scopeKeyByProjectRef = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map(
        (projectRef) =>
          [scopedProjectKey(projectRef.environmentId, projectRef.projectId), scope.key] as const,
      ),
    ),
  );
  const latestActivityByScope = new Map<string, number>();
  const recordActivity = (scopeKey: string | undefined, timestamp: number) => {
    if (!scopeKey || !Number.isFinite(timestamp)) return;
    latestActivityByScope.set(
      scopeKey,
      Math.max(latestActivityByScope.get(scopeKey) ?? Number.NEGATIVE_INFINITY, timestamp),
    );
  };

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    recordActivity(
      scopeKeyByProjectRef.get(scopedProjectKey(thread.environmentId, thread.projectId)),
      getThreadSortTimestamp(thread, input.projectSortOrder),
    );
  }
  for (const pendingTask of input.pendingTasks) {
    recordActivity(
      scopeKeyByProjectRef.get(
        scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
      ),
      Date.parse(pendingTask.message.createdAt),
    );
  }

  return Arr.sort(
    input.scopes,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        title: Order.String,
        key: Order.String,
      }),
      (scope: HomeProjectScope) => ({
        timestamp:
          latestActivityByScope.get(scope.key) ??
          Math.max(
            ...scope.projects.map((project) =>
              getProjectSortTimestamp(project, input.projectSortOrder),
            ),
          ),
        title: scope.title,
        key: scope.key,
      }),
    ),
  );
}
