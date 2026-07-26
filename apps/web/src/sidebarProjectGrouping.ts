import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  deriveProjectGroupLabel,
  type ProjectGroupingSettings,
} from "./logicalProject";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

/**
 * Which class of project a grouping call is asking about.
 *
 * A Hermes-style agent instance is backed by a *synthetic* project row so
 * `thread.project_id` can stay `NOT NULL` — it carries a real (empty)
 * workspace directory under `<t3home>/agents/<instanceId>/` and is a legal
 * project in every structural sense. It is emphatically not a workspace the
 * user picked, so it must never appear in a "pick a project" surface: the
 * sidebar Projects list, the command palette project picker, the draft
 * headline project menu, or the landing route's most-recent-project fallback.
 *
 * `agentInstanceId` is the discriminator, and it rides on
 * `OrchestrationProjectShell` — which is what every client-side project value
 * actually is — so it is available on every project the UI can see.
 */
export type SidebarProjectKind = "workspace" | "agent";

/**
 * True for the synthetic project row that backs an agent instance.
 *
 * `!= null` on purpose: the contract decodes a default of `null`, but an older
 * cached snapshot can omit the field entirely, and "not reported" must mean
 * "ordinary project" — never "agent", which would hide a real workspace from
 * every picker.
 */
export function isAgentProject(project: Pick<Project, "agentInstanceId">): boolean {
  return project.agentInstanceId != null;
}

/**
 * Narrow a project list to one kind.
 *
 * Callers should prefer passing `kind` to `buildSidebarProjectSnapshots`,
 * which defaults to `"workspace"`; this is exported for the handful of
 * surfaces that consume the raw project list without going through the
 * grouping builders (the landing route's most-recent project, the default
 * project ref behind the new-thread shortcut).
 */
export function selectProjectsOfKind<TProject extends Pick<Project, "agentInstanceId">>(
  projects: ReadonlyArray<TProject>,
  kind: SidebarProjectKind,
): TProject[] {
  return projects.filter((project) =>
    kind === "agent" ? isAgentProject(project) : !isAgentProject(project),
  );
}

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  // True iff every non-primary member of this group lives in a
  // desktopLocal env (today: the WSL backend). The sidebar uses this
  // to differentiate "lives on this machine but in a sandbox" from
  // "lives on a real remote" so the project header can pick a
  // container icon instead of the generic cloud icon.
  allRemoteMembersAreDesktopLocal: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
}

export interface SidebarProjectPickerEntry {
  group: SidebarProjectSnapshot;
  targetProject: SidebarProjectGroupMember;
  isPreferred: boolean;
}

interface SidebarProjectGroupCandidate {
  readonly logicalKey: string;
  readonly project: Project;
}

function getProjectFreshnessTime(project: Project): number {
  const updatedAtTime = Date.parse(project.updatedAt);
  if (Number.isFinite(updatedAtTime)) {
    return updatedAtTime;
  }
  const createdAtTime = Date.parse(project.createdAt);
  return Number.isFinite(createdAtTime) ? createdAtTime : 0;
}

function shouldReplaceDuplicateMember(input: {
  existingMember: Project;
  candidateMember: Project;
  primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  if (
    input.primaryEnvironmentId !== null &&
    input.existingMember.environmentId !== input.primaryEnvironmentId &&
    input.candidateMember.environmentId === input.primaryEnvironmentId
  ) {
    return true;
  }

  const existingFreshness = getProjectFreshnessTime(input.existingMember);
  const candidateFreshness = getProjectFreshnessTime(input.candidateMember);
  if (candidateFreshness !== existingFreshness) {
    return candidateFreshness > existingFreshness;
  }

  return input.candidateMember.id > input.existingMember.id;
}

function collectProjectWinnersByPhysicalKey(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, SidebarProjectGroupCandidate> {
  const winnersByPhysicalKey = new Map<string, SidebarProjectGroupCandidate>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const existing = winnersByPhysicalKey.get(physicalProjectKey);
    if (!existing) {
      winnersByPhysicalKey.set(physicalProjectKey, { logicalKey, project });
      continue;
    }
    if (
      shouldReplaceDuplicateMember({
        existingMember: existing.project,
        candidateMember: project,
        primaryEnvironmentId: input.primaryEnvironmentId,
      })
    ) {
      winnersByPhysicalKey.set(physicalProjectKey, { logicalKey, project });
    }
  }
  return winnersByPhysicalKey;
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const [physicalProjectKey, winner] of collectProjectWinnersByPhysicalKey(input)) {
    mapping.set(physicalProjectKey, winner.logicalKey);
  }
  return mapping;
}

export function buildSidebarProjectSnapshots(rawInput: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  // Returns true when an env id maps to a desktopLocal saved-env
  // record (today: the WSL backend). Defaults to "false for every
  // env" so callers that don't care about the distinction get the
  // legacy behavior.
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
  // Which class of project to group. Defaults to "workspace" so every
  // existing caller — and every future one that forgets to think about it —
  // excludes synthetic agent projects. The Agents sidebar section opts in
  // explicitly with "agent". See `SidebarProjectKind`.
  kind?: SidebarProjectKind;
}): SidebarProjectSnapshot[] {
  // Filter first, at the single choke point every project-listing surface
  // already funnels through, so a new caller inherits the exclusion instead
  // of having to remember it.
  const input = {
    ...rawInput,
    projects: selectProjectsOfKind(rawInput.projects, rawInput.kind ?? "workspace"),
  };
  const winnersByPhysicalKey = collectProjectWinnersByPhysicalKey(input);
  const groupedMembers = new Map<string, SidebarProjectGroupMember[]>();
  for (const { logicalKey, project } of winnersByPhysicalKey.values()) {
    const member: SidebarProjectGroupMember = {
      ...project,
      physicalProjectKey: derivePhysicalProjectKey(project),
      environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
    };
    const existingMembers = groupedMembers.get(logicalKey);
    if (existingMembers) {
      existingMembers.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }

  const projectRefsByLogicalKey = new Map<string, ScopedProjectRef[]>();
  const seenProjectRefs = new Set<string>();
  for (const project of input.projects) {
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const logicalKey =
      winnersByPhysicalKey.get(physicalProjectKey)?.logicalKey ??
      deriveLogicalProjectKeyFromSettings(project, input.settings);
    const projectRefKey = `${project.environmentId}:${project.id}`;
    if (seenProjectRefs.has(projectRefKey)) continue;
    seenProjectRefs.add(projectRefKey);

    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const existingRefs = projectRefsByLogicalKey.get(logicalKey);
    if (existingRefs) {
      existingRefs.push(projectRef);
    } else {
      projectRefsByLogicalKey.set(logicalKey, [projectRef]);
    }
  }

  const result: SidebarProjectSnapshot[] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    if (seen.has(logicalKey)) {
      continue;
    }
    seen.add(logicalKey);

    const members = groupedMembers.get(logicalKey) ?? [];
    const representative =
      (input.primaryEnvironmentId
        ? members.find((member) => member.environmentId === input.primaryEnvironmentId)
        : null) ?? members[0];
    if (!representative) {
      continue;
    }

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteMembers = members.filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    );
    const remoteEnvironmentLabels = remoteMembers
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);
    const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
    const allRemoteMembersAreDesktopLocal =
      remoteMembers.length > 0 &&
      remoteMembers.every((member) => isDesktopLocal(member.environmentId));

    result.push({
      ...representative,
      projectKey: logicalKey,
      displayName:
        members.length > 1
          ? deriveProjectGroupLabel({
              representative,
              members,
            })
          : representative.title,
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      allRemoteMembersAreDesktopLocal,
      memberProjects: members,
      memberProjectRefs: projectRefsByLogicalKey.get(logicalKey) ?? [],
      remoteEnvironmentLabels,
    });
  }

  return result;
}

export function buildSidebarProjectPickerEntries(input: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  preferredProjectRef: ScopedProjectRef | null;
}) {
  // Second gate, deliberately redundant with `buildSidebarProjectSnapshots`.
  // Every group reaching here already came from that builder, but this is the
  // last function before a project becomes a *selectable option*, and a picker
  // that offers an agent's synthetic directory is the exact bug the
  // synthetic-project design is most likely to produce.
  const entries = input.groups
    .filter((group) => !isAgentProject(group))
    .flatMap((group): SidebarProjectPickerEntry[] => {
      const isPreferred = input.preferredProjectRef
        ? group.memberProjectRefs.some(
            (projectRef) =>
              projectRef.environmentId === input.preferredProjectRef?.environmentId &&
              projectRef.projectId === input.preferredProjectRef.projectId,
          )
        : false;
      const preferredProject = isPreferred
        ? (group.memberProjects.find(
            (project) =>
              project.environmentId === input.preferredProjectRef?.environmentId &&
              project.id === input.preferredProjectRef?.projectId,
          ) ??
          group.memberProjects.find(
            (project) => project.environmentId === input.preferredProjectRef?.environmentId,
          ))
        : null;
      const targetProject =
        preferredProject ??
        group.memberProjects.find(
          (project) => project.environmentId === group.environmentId && project.id === group.id,
        ) ??
        group.memberProjects[0];
      if (!targetProject) return [];

      return [{ group, targetProject, isPreferred }];
    });
  const preferredIndex = entries.findIndex((entry) => entry.isPreferred);
  if (preferredIndex <= 0) return entries;

  return [
    entries[preferredIndex]!,
    ...entries.slice(0, preferredIndex),
    ...entries.slice(preferredIndex + 1),
  ];
}
