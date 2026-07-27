import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type ModelSelection,
  type ScopedThreadRef,
  type ThreadForkProvenance,
  ThreadId,
  ProviderInstanceId,
  WorkspaceTaskId,
} from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";

import { DraftId, type DraftSessionState, useComposerDraftStore } from "../composerDraftStore";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { refreshClosedTaskTabsForEnvironment, useClosedTaskTabs } from "../lib/closedTaskTabsState";
import { newDraftId, newThreadId } from "../lib/utils";
import { resolveWorkspaceTaskId } from "../lib/workspaceTasks";
import { primaryServerKeybindingsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { readThreadShell, useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { useClientSettings } from "./useSettings";

export type WorkspaceTaskTab =
  | {
      readonly kind: "server";
      readonly key: string;
      readonly threadRef: ScopedThreadRef;
      readonly title: string;
      readonly modelSelection: ModelSelection;
      readonly position: number;
      readonly active: boolean;
      readonly working: boolean;
      readonly blocked: boolean;
      readonly forkProvenance: ThreadForkProvenance | null;
    }
  | {
      readonly kind: "draft";
      readonly key: string;
      readonly draftId: DraftId;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly modelSelection: ModelSelection | null;
      readonly position: number;
      readonly active: boolean;
      readonly working: false;
      readonly blocked: false;
      readonly forkProvenance: ThreadForkProvenance | null;
    };

export type ClosedWorkspaceTaskTab =
  | {
      readonly kind: "server";
      readonly key: string;
      readonly threadRef: ScopedThreadRef;
      readonly title: string;
      readonly position: number;
      readonly forkProvenance: ThreadForkProvenance | null;
      readonly closedAt: string;
    }
  | {
      readonly kind: "draft";
      readonly key: string;
      readonly draftId: DraftId;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly position: number;
      readonly forkProvenance: ThreadForkProvenance | null;
      readonly closedAt: string;
    };

interface CurrentTaskContext {
  readonly environmentId: EnvironmentThreadShell["environmentId"];
  readonly projectId: EnvironmentThreadShell["projectId"];
  readonly threadId: ThreadId;
  readonly workspaceTaskId: WorkspaceTaskId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly runtimeMode: EnvironmentThreadShell["runtimeMode"];
  readonly interactionMode: EnvironmentThreadShell["interactionMode"];
  readonly modelSelection: ModelSelection;
  readonly logicalProjectKey: string;
  readonly sourceIsServer: boolean;
}

function draftTaskId(draft: DraftSessionState): WorkspaceTaskId {
  return draft.workspaceTaskId ?? WorkspaceTaskId.make(String(draft.threadId));
}

async function waitForThreadShellState(
  threadRef: ScopedThreadRef,
  expectedToExist: boolean,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while ((readThreadShell(threadRef) !== null) !== expectedToExist && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

export function useWorkspaceTaskTabs() {
  const router = useRouter();
  const creatingTabRef = useRef(false);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const draftSessions = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  const currentServerThread =
    routeTarget?.kind === "server"
      ? (threads.find(
          (thread) =>
            thread.environmentId === routeTarget.threadRef.environmentId &&
            thread.id === routeTarget.threadRef.threadId,
        ) ?? null)
      : null;
  const currentDraft =
    routeTarget?.kind === "draft" ? (draftSessions[routeTarget.draftId] ?? null) : null;
  const currentProject = currentServerThread
    ? (projects.find(
        (project) =>
          project.environmentId === currentServerThread.environmentId &&
          project.id === currentServerThread.projectId,
      ) ?? null)
    : currentDraft
      ? (projects.find(
          (project) =>
            project.environmentId === currentDraft.environmentId &&
            project.id === currentDraft.projectId,
        ) ?? null)
      : null;

  const currentContext: CurrentTaskContext | null = currentServerThread
    ? {
        environmentId: currentServerThread.environmentId,
        projectId: currentServerThread.projectId,
        threadId: currentServerThread.id,
        workspaceTaskId: resolveWorkspaceTaskId(currentServerThread),
        branch: currentServerThread.branch,
        worktreePath: currentServerThread.worktreePath,
        runtimeMode: currentServerThread.runtimeMode,
        interactionMode: currentServerThread.interactionMode,
        modelSelection: currentServerThread.modelSelection,
        logicalProjectKey: currentProject
          ? deriveLogicalProjectKeyFromSettings(currentProject, projectGroupingSettings)
          : scopedProjectKey(
              scopeProjectRef(currentServerThread.environmentId, currentServerThread.projectId),
            ),
        sourceIsServer: true,
      }
    : currentDraft && currentProject
      ? {
          environmentId: currentDraft.environmentId,
          projectId: currentDraft.projectId,
          threadId: currentDraft.threadId,
          workspaceTaskId: draftTaskId(currentDraft),
          branch: currentDraft.branch,
          worktreePath: currentDraft.worktreePath,
          runtimeMode: currentDraft.runtimeMode,
          interactionMode: currentDraft.interactionMode,
          modelSelection: currentProject.defaultModelSelection ?? {
            instanceId: ProviderInstanceId.make("codex"),
            model: "default",
          },
          logicalProjectKey: currentDraft.logicalProjectKey,
          sourceIsServer: false,
        }
      : null;
  const supportsTaskTabs =
    currentContext !== null &&
    serverConfigs.get(currentContext.environmentId)?.environment.capabilities.workspaceTaskTabs ===
      true;
  const closedServerTaskTabs = useClosedTaskTabs(
    supportsTaskTabs ? currentContext.environmentId : null,
  );

  const tabs = useMemo<ReadonlyArray<WorkspaceTaskTab>>(() => {
    if (currentContext === null) return [];
    const serverTabs: WorkspaceTaskTab[] = threads.flatMap((thread) => {
      if (
        thread.environmentId !== currentContext.environmentId ||
        resolveWorkspaceTaskId(thread) !== currentContext.workspaceTaskId ||
        thread.tabClosedAt != null
      ) {
        return [];
      }
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      return [
        {
          kind: "server",
          key: scopedThreadKey(threadRef),
          threadRef,
          title: thread.tabLabel ?? (thread.tabPosition === 0 ? "Main" : thread.title),
          modelSelection: thread.modelSelection,
          position: thread.tabPosition ?? 0,
          active:
            routeTarget?.kind === "server" &&
            routeTarget.threadRef.environmentId === thread.environmentId &&
            routeTarget.threadRef.threadId === thread.id,
          working: thread.session?.status === "running" || thread.session?.status === "starting",
          blocked: thread.hasPendingApprovals || thread.hasPendingUserInput,
          forkProvenance: thread.forkProvenance ?? null,
        },
      ];
    });
    const draftTabs: WorkspaceTaskTab[] = Object.entries(draftSessions).flatMap(
      ([rawDraftId, draft]) => {
        if (
          draft.environmentId !== currentContext.environmentId ||
          draftTaskId(draft) !== currentContext.workspaceTaskId ||
          draft.tabClosedAt != null ||
          draft.promotedTo != null
        ) {
          return [];
        }
        const draftId = DraftId.make(rawDraftId);
        const composer = useComposerDraftStore.getState().getComposerDraft(draftId);
        const activeProvider = composer?.activeProvider ?? null;
        const modelSelection = activeProvider
          ? (composer?.modelSelectionByProvider[activeProvider] ?? null)
          : null;
        return [
          {
            kind: "draft",
            key: `draft:${draftId}`,
            draftId,
            threadId: draft.threadId,
            title: draft.tabLabel ?? `Tab ${(draft.tabPosition ?? 0) + 1}`,
            modelSelection,
            position: draft.tabPosition ?? 0,
            active: routeTarget?.kind === "draft" && routeTarget.draftId === draftId,
            working: false,
            blocked: false,
            forkProvenance: draft.forkProvenance ?? null,
          },
        ];
      },
    );
    return [...serverTabs, ...draftTabs].toSorted(
      (left, right) => left.position - right.position || left.key.localeCompare(right.key),
    );
  }, [currentContext, draftSessions, routeTarget, threads]);

  const closedTabs = useMemo<ReadonlyArray<ClosedWorkspaceTaskTab>>(() => {
    if (currentContext === null) return [];
    const serverTabs: ClosedWorkspaceTaskTab[] = closedServerTaskTabs.flatMap((thread) => {
      if (
        resolveWorkspaceTaskId(thread) !== currentContext.workspaceTaskId ||
        thread.tabClosedAt == null
      ) {
        return [];
      }
      const threadRef = scopeThreadRef(currentContext.environmentId, thread.id);
      return [
        {
          kind: "server",
          key: scopedThreadKey(threadRef),
          threadRef,
          title: thread.tabLabel ?? (thread.tabPosition === 0 ? "Main" : thread.title),
          position: thread.tabPosition ?? 0,
          forkProvenance: thread.forkProvenance ?? null,
          closedAt: thread.tabClosedAt,
        },
      ];
    });
    const draftTabs: ClosedWorkspaceTaskTab[] = Object.entries(draftSessions).flatMap(
      ([rawDraftId, draft]) => {
        if (
          draft.environmentId !== currentContext.environmentId ||
          draftTaskId(draft) !== currentContext.workspaceTaskId ||
          draft.tabClosedAt == null ||
          draft.promotedTo != null
        ) {
          return [];
        }
        const draftId = DraftId.make(rawDraftId);
        return [
          {
            kind: "draft",
            key: `draft:${draftId}`,
            draftId,
            threadId: draft.threadId,
            title: draft.tabLabel ?? `Tab ${(draft.tabPosition ?? 0) + 1}`,
            position: draft.tabPosition ?? 0,
            forkProvenance: draft.forkProvenance ?? null,
            closedAt: draft.tabClosedAt,
          },
        ];
      },
    );
    return [...serverTabs, ...draftTabs].toSorted(
      (left, right) =>
        right.closedAt.localeCompare(left.closedAt) ||
        left.position - right.position ||
        left.key.localeCompare(right.key),
    );
  }, [closedServerTaskTabs, currentContext, draftSessions]);

  const navigateToTab = useCallback(
    (tab: WorkspaceTaskTab | ClosedWorkspaceTaskTab) => {
      if (tab.kind === "server") {
        return router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(tab.threadRef),
        });
      }
      return router.navigate({
        to: "/draft/$draftId",
        params: { draftId: tab.draftId },
      });
    },
    [router],
  );

  const createTab = useCallback(
    async (mode: "fresh" | "portable" = "fresh") => {
      if (currentContext === null || !supportsTaskTabs) return;
      if (mode === "portable" && !currentContext.sourceIsServer) return;
      if (creatingTabRef.current) return;
      creatingTabRef.current = true;

      try {
        const draftId = newDraftId();
        const threadId = newThreadId();
        const createdAt = new Date().toISOString();
        const position =
          [...tabs, ...closedTabs].reduce((max, tab) => Math.max(max, tab.position), -1) + 1;
        const forkProvenance: ThreadForkProvenance = {
          mode,
          sourceThreadId: mode === "portable" ? currentContext.threadId : null,
          createdAt,
        };
        const store = useComposerDraftStore.getState();
        const currentComposer =
          routeTarget?.kind === "server"
            ? store.getComposerDraft(routeTarget.threadRef)
            : routeTarget?.kind === "draft"
              ? store.getComposerDraft(routeTarget.draftId)
              : null;
        const activeProvider = currentComposer?.activeProvider ?? null;
        const carriedModelSelection =
          (activeProvider
            ? currentComposer?.modelSelectionByProvider[activeProvider]
            : undefined) ?? currentContext.modelSelection;

        store.setLogicalProjectDraftThreadId(
          currentContext.logicalProjectKey,
          scopeProjectRef(currentContext.environmentId, currentContext.projectId),
          draftId,
          {
            threadId,
            workspaceTaskId: currentContext.workspaceTaskId,
            tabPosition: position,
            tabLabel: null,
            forkProvenance,
            createdAt,
            branch: currentContext.branch,
            worktreePath: currentContext.worktreePath,
            envMode: currentContext.worktreePath ? "worktree" : "local",
            startFromOrigin: false,
            runtimeMode: currentContext.runtimeMode,
            interactionMode: currentContext.interactionMode,
            retainPreviousDraft: true,
          },
        );
        store.applyStickyState(draftId);
        store.setModelSelection(draftId, carriedModelSelection, { replaceOptions: true });

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
        });
      } finally {
        creatingTabRef.current = false;
      }
    },
    [closedTabs, currentContext, routeTarget, router, supportsTaskTabs, tabs],
  );

  const closeTab = useCallback(
    async (tab: WorkspaceTaskTab) => {
      if (tabs.length <= 1 || tab.working || tab.blocked) return;
      const index = tabs.findIndex((candidate) => candidate.key === tab.key);
      const fallback = tabs[index + 1] ?? tabs[index - 1] ?? null;
      if (tab.kind === "draft") {
        useComposerDraftStore
          .getState()
          .setDraftThreadContext(tab.draftId, { tabClosedAt: new Date().toISOString() });
      } else {
        const result = await updateThreadMetadata({
          environmentId: tab.threadRef.environmentId,
          input: {
            threadId: tab.threadRef.threadId,
            tabClosedAt: new Date().toISOString(),
          },
        });
        if (result._tag === "Failure") return;
        await waitForThreadShellState(tab.threadRef, false);
        refreshClosedTaskTabsForEnvironment(tab.threadRef.environmentId);
      }
      if (tab.active && fallback) {
        await navigateToTab(fallback);
      }
    },
    [navigateToTab, tabs, updateThreadMetadata],
  );

  const reopenTab = useCallback(
    async (tab: ClosedWorkspaceTaskTab) => {
      if (tab.kind === "draft") {
        useComposerDraftStore.getState().setDraftThreadContext(tab.draftId, { tabClosedAt: null });
      } else {
        const result = await updateThreadMetadata({
          environmentId: tab.threadRef.environmentId,
          input: {
            threadId: tab.threadRef.threadId,
            tabClosedAt: null,
          },
        });
        if (result._tag === "Failure") return;
        await waitForThreadShellState(tab.threadRef, true);
        refreshClosedTaskTabsForEnvironment(tab.threadRef.environmentId);
      }
      await navigateToTab(tab);
    },
    [navigateToTab, updateThreadMetadata],
  );

  const reopenLastClosedTab = useCallback(async () => {
    const lastClosed = closedTabs[0];
    if (lastClosed) await reopenTab(lastClosed);
  }, [closedTabs, reopenTab]);

  return {
    tabs,
    closedTabs,
    keybindings,
    hasTask: currentContext !== null && supportsTaskTabs,
    canForkContext: currentContext?.sourceIsServer === true && supportsTaskTabs,
    createTab,
    closeTab,
    reopenTab,
    reopenLastClosedTab,
    navigateToTab,
  } as const;
}
