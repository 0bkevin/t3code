import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import type { WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { environmentServerConfigsAtom } from "../../state/server";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { PendingTaskListRow } from "../threads/thread-list-items";
import { ThreadListV2Row } from "../threads/thread-list-v2-items";
import {
  buildThreadListV2Items,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2Item,
} from "../threads/threadListV2";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectSortOrder,
} from "./homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import { WorkspaceConnectionStatus } from "./WorkspaceConnectionStatus";
import { shouldShowWorkspaceConnectionStatus } from "./workspace-connection-status";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onAddConnection: () => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  /** Resolves true iff the settle was dispatched and succeeded. */
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}

function deriveEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: boolean } {
  const { catalogState } = props;
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load projects and start coding sessions.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects and threads from the saved environment.",
      loading: true,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected environment did not report any projects.",
      loading: false,
    };
  }

  return {
    title: "No threads yet",
    detail: "Create a task to start a new coding session in one of your connected projects.",
    loading: false,
  };
}

function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const insets = useSafeAreaInsets();
  const accentColor = useThemeColor("--color-icon-muted");

  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);

  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects: props.projects,
        environmentId: props.selectedEnvironmentId,
        projectGroupingMode: props.projectGroupingMode,
      }),
    [props.projectGroupingMode, props.projects, props.selectedEnvironmentId],
  );
  const hasSearchQuery = props.searchQuery.trim().length > 0;

  const projectCwdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot);
    }
    return map;
  }, [props.projects]);

  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [props.projects]);

  const v2ProjectScopeKey = props.selectedProjectKey;
  const v2ScopeProjects = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: projectScopes,
        threads: props.threads,
        pendingTasks: props.pendingTasks,
        projectSortOrder: props.projectSortOrder,
      }),
    [
      props.pendingTasks,
      props.projects,
      props.projectSortOrder,
      props.selectedEnvironmentId,
      props.threads,
      projectScopes,
    ],
  );
  const v2ScopedProjectGroup = useMemo(
    () =>
      v2ProjectScopeKey === null
        ? null
        : (v2ScopeProjects.find(
            (scope) =>
              scope.key === v2ProjectScopeKey ||
              scope.projectRefs.some(
                (projectRef) =>
                  scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
                  v2ProjectScopeKey,
              ),
          ) ?? null),
    [v2ProjectScopeKey, v2ScopeProjects],
  );
  const v2ProjectTitleByProjectKey = useMemo(
    () =>
      new Map(
        v2ScopeProjects.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [v2ScopeProjects],
  );
  const v2ScopedProjectKeys = useMemo(
    () =>
      v2ScopedProjectGroup === null
        ? null
        : new Set(
            v2ScopedProjectGroup.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [v2ScopedProjectGroup],
  );
  // One flat list in creation order, no grouping.
  // Settled threads collapse into a recency tail below the card block.
  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells — no snapshot merging or
  // optimistic holds.
  // PR states stream in per-row (rows own the VCS subscriptions); a merged or
  // closed PR auto-settles its thread on the next partition (mirrors web).
  const [changeRequestStateByKey, setChangeRequestStateByKey] = useState<
    ReadonlyMap<string, "open" | "closed" | "merged">
  >(() => new Map());
  const handleChangeRequestState = useCallback(
    (threadKey: string, state: "open" | "closed" | "merged" | null) => {
      setChangeRequestStateByKey((current) => {
        if ((current.get(threadKey) ?? null) === state) return current;
        const next = new Map(current);
        if (state === null) {
          next.delete(threadKey);
        } else {
          next.set(threadKey, state);
        }
        return next;
      });
    },
    [],
  );
  const handleSettleThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onSettleThread(thread);
    },
    [props.onSettleThread],
  );
  const handleDeleteThread = props.onDeleteThread;
  const handleUnsettleThread = props.onUnsettleThread;
  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${props.selectedEnvironmentId ?? "all"}:${v2ProjectScopeKey ?? "all"}:${props.searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  // now is quantized to the minute and ticks so the inactivity auto-settle
  // boundary is actually crossed while the app stays open (mirrors web);
  // without a clock dependency the partition memoizes a frozen "now".
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
    return () => clearInterval(id);
  }, []);
  // Threads on servers without the settlement capability never classify as
  // settled (the user could neither un-settle nor pin them).
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const settlementEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSettlement === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const snoozeEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSnooze === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const threadListV2Layout = useMemo(
    // Settled threads are live shells; archived threads keep their original
    // "hidden from lists" meaning.
    () =>
      buildThreadListV2Items({
        threads: props.threads.filter((thread) => thread.archivedAt === null),
        environmentId: props.selectedEnvironmentId,
        projectRefs: v2ScopedProjectGroup === null ? null : v2ScopedProjectGroup.projectRefs,
        searchQuery: props.searchQuery,
        changeRequestStateByKey,
        settlementEnvironmentIds,
        snoozeEnvironmentIds,
        settledLimit: settledVisibleCount,
        now: `${nowMinute}:00.000Z`,
        snoozeNow: new Date().toISOString(),
      }),
    [
      changeRequestStateByKey,
      nowMinute,
      snoozeWakeTick,
      settledVisibleCount,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      props.searchQuery,
      props.selectedEnvironmentId,
      props.threads,
      v2ScopedProjectGroup,
    ],
  );
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  const threadListV2Items = threadListV2Layout.items;

  const renderV2Item = useCallback(
    ({ item }: { readonly item: ThreadListV2Item }) => (
      <ThreadListV2Row
        thread={item.thread}
        variant={item.variant}
        showSettledDivider={item.showSettledDivider}
        project={
          projectByKey.get(scopedProjectKey(item.thread.environmentId, item.thread.projectId)) ??
          null
        }
        projectTitle={v2ProjectTitleByProjectKey.get(
          scopedProjectKey(item.thread.environmentId, item.thread.projectId),
        )}
        providerDriver={
          serverConfigs
            .get(item.thread.environmentId)
            ?.providers.find(
              (provider) =>
                provider.instanceId ===
                (item.thread.session?.providerInstanceId ?? item.thread.modelSelection.instanceId),
            )?.driver ?? null
        }
        environmentLabel={
          Object.keys(props.savedConnectionsById).length > 1
            ? (props.savedConnectionsById[item.thread.environmentId]?.environmentLabel ?? null)
            : null
        }
        onSelectThread={props.onSelectThread}
        onDeleteThread={handleDeleteThread}
        onArchiveThread={props.onArchiveThread}
        settlementSupported={settlementEnvironmentIds.has(item.thread.environmentId)}
        onSettleThread={handleSettleThread}
        onUnsettleThread={handleUnsettleThread}
        onChangeRequestState={handleChangeRequestState}
        projectCwd={
          projectCwdByKey.get(scopedProjectKey(item.thread.environmentId, item.thread.projectId)) ??
          null
        }
        onSwipeableClose={handleSwipeableClose}
        onSwipeableWillOpen={handleSwipeableWillOpen}
      />
    ),
    [
      handleChangeRequestState,
      handleDeleteThread,
      handleSettleThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      projectByKey,
      projectCwdByKey,
      props.onArchiveThread,
      props.onSelectThread,
      props.savedConnectionsById,
      serverConfigs,
      settlementEnvironmentIds,
      v2ProjectTitleByProjectKey,
    ],
  );
  const v2KeyExtractor = useCallback(
    (item: ThreadListV2Item) => `${item.thread.environmentId}:${item.thread.id}`,
    [],
  );

  /* Empty states */
  // The signal must ignore the search/environment filters: an active query
  // that matches nothing needs the in-list "No results" state, not the
  // full-page "No threads yet". Settled threads are unarchived live shells,
  // so this check covers them too.
  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) || props.pendingTasks.length > 0;
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.savedConnectionsById[props.selectedEnvironmentId]?.environmentLabel ??
        "this environment");
  const shouldShowConnectionStatus = shouldShowWorkspaceConnectionStatus(props.catalogState);
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });
  const connectionStatus =
    shouldShowConnectionStatus && Platform.OS !== "ios" ? (
      <View
        className="absolute left-0 right-0 items-center"
        style={{ bottom: Math.max(insets.bottom, 18) + 76 }}
      >
        <WorkspaceConnectionStatus state={props.catalogState} onPress={props.onOpenEnvironments} />
      </View>
    ) : null;

  if (!hasAnyThreads) {
    return (
      <View
        className="flex-1 items-center justify-center bg-screen px-8"
        style={{
          paddingBottom: Math.max(insets.bottom, 24),
          paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
        }}
      >
        <View className="w-full max-w-[430px]">
          <EmptyState
            title={emptyState.title}
            detail={emptyState.detail}
            actionLabel={!props.catalogState.hasReadyEnvironment ? "Add environment" : undefined}
            onAction={!props.catalogState.hasReadyEnvironment ? props.onAddConnection : undefined}
            variant="plain"
          />
          {emptyState.loading && !shouldShowConnectionStatus ? (
            <View className="mt-4 items-center">
              <ActivityIndicator color={accentColor} />
            </View>
          ) : null}
          {shouldShowConnectionStatus && Platform.OS === "ios" ? (
            <View className="mt-4">
              <WorkspaceConnectionStatus
                state={props.catalogState}
                onPress={props.onOpenEnvironments}
                variant="sidebar"
              />
            </View>
          ) : null}
        </View>
        {connectionStatus}
      </View>
    );
  }

  const listHeader = (
    <>
      {Platform.OS === "ios" ? null : <HomeTopContentSpacer />}

      {shouldShowConnectionStatus && Platform.OS === "ios" ? (
        <View className="pb-4">
          <WorkspaceConnectionStatus
            state={props.catalogState}
            onPress={props.onOpenEnvironments}
            variant="sidebar"
          />
        </View>
      ) : null}
    </>
  );

  // v2 renders queued offline tasks above the thread cards — they are not
  // thread shells, so the v2 item builder never sees them, but they must
  // stay visible and deletable while their environment is offline. They
  // respect the same environment scope and search filter as the list.
  const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
  const v2PendingTasks = props.pendingTasks.filter(
    (pendingTask) =>
      (props.selectedEnvironmentId === null ||
        pendingTask.message.environmentId === props.selectedEnvironmentId) &&
      (v2ScopedProjectKeys === null ||
        v2ScopedProjectKeys.has(
          scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
        )) &&
      (v2SearchQuery.length === 0 || pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
  );
  // Project scoping lives in the header filter menu (no inline chip row on
  // mobile — the menu is the one filter surface).
  const v2ListHeader = (
    <>
      {listHeader}
      {v2PendingTasks.map((pendingTask, index) => (
        <PendingTaskListRow
          key={pendingTask.message.messageId}
          variant="compact"
          pendingTask={pendingTask}
          environmentLabel={
            props.savedConnectionsById[pendingTask.message.environmentId]?.environmentLabel ?? null
          }
          isLast={index === v2PendingTasks.length - 1}
          onSelectPendingTask={props.onSelectPendingTask}
          onDeletePendingTask={props.onDeletePendingTask}
        />
      ))}
    </>
  );

  // Search outranks the scope — "No results" names the actionable fact when a
  // query is active. Snoozed threads outrank the rest: "No threads yet" over
  // an inbox that is merely all-snoozed reads as data loss. Pending tasks
  // render in the header, so the list showing them isn't empty in the user's
  // eyes.
  const v2SnoozedCount = threadListV2Layout.snoozedCount;
  const v2ListEmpty =
    v2PendingTasks.length > 0 ? null : hasSearchQuery ? (
      v2SnoozedCount > 0 ? (
        // The snoozed threads already passed this search filter: "No
        // results" would claim nothing matched when matches are merely
        // parked.
        <EmptyState
          title={
            v2SnoozedCount === 1 ? "1 matching thread snoozed" : `All matching threads snoozed`
          }
          detail={`Threads matching "${props.searchQuery}" are snoozed and return when their wake time passes.`}
        />
      ) : (
        <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
      )
    ) : v2SnoozedCount > 0 ? (
      <EmptyState
        title={v2SnoozedCount === 1 ? "1 thread snoozed" : `${v2SnoozedCount} threads snoozed`}
        detail="Snoozed threads return when their wake time passes."
      />
    ) : v2ScopedProjectGroup !== null ? (
      <EmptyState
        title={`No threads in ${v2ScopedProjectGroup.title}`}
        detail="Choose another project or create a new task."
      />
    ) : selectedEnvironmentLabel ? (
      <EmptyState
        title={`No threads in ${selectedEnvironmentLabel}`}
        detail="Choose another environment or create a new task."
      />
    ) : (
      <EmptyState title="No threads yet" detail="Create a task to start a new coding session." />
    );

  return (
    <View className="flex-1 bg-screen">
      <SwipeableScrollGateProvider enabled={swipeEnabled}>
        <FlatList
          data={threadListV2Items}
          renderItem={renderV2Item}
          keyExtractor={v2KeyExtractor}
          extraData={{
            projectByKey,
            serverConfigs,
            savedConnectionsById: props.savedConnectionsById,
          }}
          ListHeaderComponent={v2ListHeader}
          ListFooterComponent={
            threadListV2Layout.hiddenSettledCount > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Show ${Math.min(threadListV2Layout.hiddenSettledCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
                onPress={showMoreSettled}
                className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <Text className="text-xs font-t3-medium text-foreground-muted">
                  Show more ({threadListV2Layout.hiddenSettledCount} settled hidden)
                </Text>
              </Pressable>
            ) : null
          }
          ListEmptyComponent={v2ListEmpty}
          style={{ flex: 1 }}
          automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          {...scrollGateHandlers}
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingBottom:
              Platform.OS === "ios"
                ? Math.max(insets.bottom, 24) + 96
                : Math.max(insets.bottom, 16) + 88,
          }}
        />
      </SwipeableScrollGateProvider>
      {connectionStatus}
    </View>
  );
}
