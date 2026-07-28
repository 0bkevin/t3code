import { FolderGit2Icon, LoaderIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { WorktreeInfo, WorktreePruneSkipReason } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { usePrimaryEnvironment } from "../../state/environments";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const ALL_PROJECTS = "all";

const AUTO_PRUNE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "off", label: "Never" },
  { value: "7", label: "After 7 days" },
  { value: "14", label: "After 14 days" },
  { value: "30", label: "After 30 days" },
];

type StatusFilter = "attention" | "safe" | "dirty" | "unpushed" | "orphaned" | "settled";

const STATUS_FILTERS: ReadonlyArray<{ key: StatusFilter; label: string }> = [
  { key: "attention", label: "Needs attention" },
  { key: "safe", label: "Safe to prune" },
  { key: "dirty", label: "Dirty" },
  { key: "unpushed", label: "Unpushed" },
  { key: "orphaned", label: "Orphaned" },
  { key: "settled", label: "Settled" },
];

const SKIP_REASON_LABEL: Record<WorktreePruneSkipReason, string> = {
  active_thread: "in use by an active thread",
  dirty: "has uncommitted changes",
  unpushed: "has unpushed commits",
  status_unavailable: "its state could not be determined",
  unknown_worktree: "it is not a managed worktree",
  remove_failed: "git failed to remove it",
};

function worktreeDisplayName(worktree: WorktreeInfo): string {
  return worktree.branch ?? (worktree.path.split("/").pop() || worktree.path);
}

function hasActiveThread(worktree: WorktreeInfo): boolean {
  return worktree.threads.some((thread) => thread.status === "active");
}

function isSettledOnly(worktree: WorktreeInfo): boolean {
  const nonDeleted = worktree.threads.filter((thread) => thread.status !== "deleted");
  return nonDeleted.length > 0 && nonDeleted.every((thread) => thread.status !== "active");
}

/**
 * Blocked from pruning by something the user can resolve (uncommitted or
 * unpushed work), as opposed to simply being in use by an active thread.
 */
function needsAttention(worktree: WorktreeInfo): boolean {
  return (
    !worktree.safeToPrune &&
    !hasActiveThread(worktree) &&
    worktree.pruneBlockers.some((blocker) => blocker === "dirty" || blocker === "unpushed")
  );
}

function matchesSearch(worktree: WorktreeInfo, query: string): boolean {
  if (query.length === 0) return true;
  const haystacks = [
    worktree.branch ?? "",
    worktree.path.split("/").pop() ?? "",
    worktree.projectTitle,
    ...worktree.threads.map((thread) => thread.title),
  ];
  return haystacks.some((value) => value.toLowerCase().includes(query));
}

function matchesStatusFilters(worktree: WorktreeInfo, filters: ReadonlySet<StatusFilter>): boolean {
  if (filters.size === 0) return true;
  for (const filter of filters) {
    switch (filter) {
      case "attention":
        if (needsAttention(worktree)) return true;
        break;
      case "safe":
        if (worktree.safeToPrune) return true;
        break;
      case "dirty":
        if (worktree.dirty === true) return true;
        break;
      case "unpushed":
        if (worktree.pruneBlockers.includes("unpushed")) return true;
        break;
      case "orphaned":
        if (worktree.orphaned) return true;
        break;
      case "settled":
        if (isSettledOnly(worktree)) return true;
        break;
    }
  }
  return false;
}

function ThreadsCell({ worktree }: { worktree: WorktreeInfo }) {
  const nonDeleted = worktree.threads.filter((thread) => thread.status !== "deleted");
  if (nonDeleted.length === 0) {
    return <span className="text-muted-foreground/60">orphaned</span>;
  }
  const [first] = nonDeleted;
  const title = first !== undefined && first.title.trim().length > 0 ? first.title : "Untitled";
  return (
    <span className="inline-flex min-w-0 max-w-56 items-baseline gap-1.5">
      <span className="truncate">{title}</span>
      {nonDeleted.length > 1 ? (
        <span className="shrink-0 text-muted-foreground/60">+{nonDeleted.length - 1}</span>
      ) : null}
      {isSettledOnly(worktree) ? (
        <span className="shrink-0 text-xs text-muted-foreground/60">settled</span>
      ) : null}
    </span>
  );
}

function ChangesCell({ worktree }: { worktree: WorktreeInfo }) {
  if (worktree.dirty === null) {
    return <span className="text-muted-foreground/60">unknown</span>;
  }
  if (!worktree.dirty) {
    return <span className="text-muted-foreground/60">clean</span>;
  }
  const count = worktree.dirtyFileCount;
  return (
    <span className="font-medium text-warning-foreground">
      {count === null || count === 0 ? "dirty" : `${count} file${count === 1 ? "" : "s"}`}
    </span>
  );
}

function SyncCell({ worktree }: { worktree: WorktreeInfo }) {
  if (worktree.branch === null) {
    return <span className="text-muted-foreground/60">detached</span>;
  }
  if (worktree.hasUpstream && !worktree.upstreamGone) {
    const ahead = worktree.aheadOfUpstreamCount ?? 0;
    const behind = worktree.behindUpstreamCount ?? 0;
    if (ahead === 0 && behind === 0) {
      return <span className="text-muted-foreground/60">synced</span>;
    }
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-xs">
        {ahead > 0 ? <span className="text-info-foreground">↑{ahead}</span> : null}
        {behind > 0 ? <span className="text-muted-foreground">↓{behind}</span> : null}
      </span>
    );
  }
  if (worktree.upstreamGone) {
    return <span className="text-muted-foreground/60">remote gone</span>;
  }
  const aheadOfDefault = worktree.aheadOfDefaultCount;
  if (aheadOfDefault === null) {
    return <span className="text-muted-foreground/60">unknown</span>;
  }
  if (aheadOfDefault === 0) {
    return <span className="text-muted-foreground/60">nothing to push</span>;
  }
  return <span className="font-mono text-xs text-info-foreground">↑{aheadOfDefault} local</span>;
}

function StateCell({ worktree }: { worktree: WorktreeInfo }) {
  if (worktree.safeToPrune) {
    return (
      <Badge size="sm" variant="success">
        Safe to prune
      </Badge>
    );
  }
  if (needsAttention(worktree)) {
    return (
      <Badge size="sm" variant="warning">
        Needs attention
      </Badge>
    );
  }
  if (hasActiveThread(worktree)) {
    return (
      <Badge size="sm" variant="info">
        In use
      </Badge>
    );
  }
  return (
    <Badge size="sm" variant="outline">
      Unknown
    </Badge>
  );
}

function WorktreeTable({
  worktrees,
  showProject,
  busyPaths,
  onDelete,
}: {
  worktrees: ReadonlyArray<WorktreeInfo>;
  showProject: boolean;
  busyPaths: ReadonlySet<string>;
  onDelete: (worktree: WorktreeInfo) => void;
}) {
  return (
    <div className="overflow-x-auto px-3 sm:px-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Branch</TableHead>
            {showProject ? <TableHead>Project</TableHead> : null}
            <TableHead>Threads</TableHead>
            <TableHead>Changes</TableHead>
            <TableHead>Sync</TableHead>
            <TableHead>Last activity</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {worktrees.map((worktree) => {
            const busy = busyPaths.has(worktree.path);
            return (
              <TableRow key={worktree.path}>
                <TableCell className="max-w-52">
                  <span className="block truncate font-mono text-[13px]" title={worktree.path}>
                    {worktreeDisplayName(worktree)}
                  </span>
                </TableCell>
                {showProject ? (
                  <TableCell className="text-muted-foreground">{worktree.projectTitle}</TableCell>
                ) : null}
                <TableCell>
                  <ThreadsCell worktree={worktree} />
                </TableCell>
                <TableCell>
                  <ChangesCell worktree={worktree} />
                </TableCell>
                <TableCell>
                  <SyncCell worktree={worktree} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {worktree.lastActivityAt === null
                    ? "—"
                    : formatRelativeTimeLabel(worktree.lastActivityAt)}
                </TableCell>
                <TableCell>
                  <StateCell worktree={worktree} />
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant={worktree.safeToPrune ? "outline" : "destructive-outline"}
                    size="sm"
                    className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                    disabled={busy}
                    onClick={() => onDelete(worktree)}
                  >
                    {busy ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                    <span className="whitespace-nowrap">
                      {worktree.safeToPrune ? "Delete" : "Force delete"}
                    </span>
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function WorktreesSettingsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const worktreesAtom = useMemo(
    () =>
      environmentId === null ? null : vcsEnvironment.listWorktrees({ environmentId, input: {} }),
    [environmentId],
  );
  const { data, error, isPending, refresh } = useEnvironmentQuery(worktreesAtom);
  const pruneWorktrees = useAtomCommand(vcsEnvironment.pruneWorktrees, { reportFailure: false });
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, { reportFailure: false });

  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS);
  const [statusFilters, setStatusFilters] = useState<ReadonlySet<StatusFilter>>(new Set());
  const [busyPaths, setBusyPaths] = useState<ReadonlySet<string>>(new Set());
  const [isBulkPruning, setIsBulkPruning] = useState(false);

  const worktrees = useMemo(() => data?.worktrees ?? [], [data]);

  const projectOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const worktree of worktrees) {
      byId.set(worktree.projectId, worktree.projectTitle);
    }
    return [...byId.entries()].map(([id, title]) => ({ id, title }));
  }, [worktrees]);

  const filtersActive =
    search.trim().length > 0 || projectFilter !== ALL_PROJECTS || statusFilters.size > 0;

  const filteredWorktrees = useMemo(() => {
    const query = search.trim().toLowerCase();
    return worktrees.filter(
      (worktree) =>
        (projectFilter === ALL_PROJECTS || worktree.projectId === projectFilter) &&
        matchesSearch(worktree, query) &&
        matchesStatusFilters(worktree, statusFilters),
    );
  }, [worktrees, search, projectFilter, statusFilters]);

  const attentionWorktrees = useMemo(
    () => filteredWorktrees.filter((worktree) => needsAttention(worktree)),
    [filteredWorktrees],
  );
  const remainingWorktrees = useMemo(
    () => filteredWorktrees.filter((worktree) => !needsAttention(worktree)),
    [filteredWorktrees],
  );
  const safeFiltered = useMemo(
    () => filteredWorktrees.filter((worktree) => worktree.safeToPrune),
    [filteredWorktrees],
  );

  const toggleStatusFilter = useCallback((key: StatusFilter) => {
    setStatusFilters((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const reportSkipped = useCallback(
    (skipped: ReadonlyArray<{ path: string; reason: WorktreePruneSkipReason }>) => {
      if (skipped.length === 0) return;
      const [first] = skipped;
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title:
            skipped.length === 1
              ? "Worktree was not removed"
              : `${skipped.length} worktrees were not removed`,
          description:
            first === undefined
              ? undefined
              : `${first.path.split("/").pop() ?? first.path}: ${SKIP_REASON_LABEL[first.reason]}${
                  skipped.length > 1 ? " (and more)" : ""
                }.`,
        }),
      );
    },
    [],
  );

  const runPrune = useCallback(
    async (paths: ReadonlyArray<string>) => {
      if (environmentId === null || paths.length === 0) return;
      const result = await pruneWorktrees({
        environmentId,
        input: { paths: [...paths] },
      });
      if (result._tag === "Success") {
        reportSkipped(result.value.skipped.map(({ path, reason }) => ({ path, reason })));
        refresh();
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to prune worktrees",
            description: failure instanceof Error ? failure.message : "An error occurred.",
          }),
        );
      }
    },
    [environmentId, pruneWorktrees, refresh, reportSkipped],
  );

  const handleDelete = useCallback(
    async (worktree: WorktreeInfo) => {
      if (environmentId === null) return;
      setBusyPaths((current) => new Set(current).add(worktree.path));
      try {
        if (worktree.safeToPrune) {
          if (
            !window.confirm(
              `Delete the worktree for "${worktreeDisplayName(worktree)}"?\n\nIt has no uncommitted or unpushed work. The branch is kept, and the worktree can be recreated if its thread becomes active again.`,
            )
          ) {
            return;
          }
          await runPrune([worktree.path]);
          return;
        }

        const lost = [
          worktree.pruneBlockers.includes("dirty") ? "uncommitted changes" : null,
          worktree.pruneBlockers.includes("unpushed") ? "unpushed commits" : null,
        ].filter((value) => value !== null);
        const inUse = worktree.pruneBlockers.includes("active_thread");
        const lines = [`Force-delete the worktree for "${worktreeDisplayName(worktree)}"?`, ""];
        if (inUse) {
          lines.push(
            "It is in use by an active thread. The thread is kept and can recreate the worktree from its branch on the next turn.",
          );
        }
        if (lost.length > 0) {
          lines.push(
            `It has ${lost.join(" and ")}. Uncommitted changes will be PERMANENTLY LOST and cannot be restored later. Commits stay on the branch.`,
          );
        } else if (!inUse) {
          lines.push(
            "Its state could not be determined, so anything uncommitted in it will be PERMANENTLY LOST.",
          );
        }
        if (!window.confirm(lines.join("\n"))) {
          return;
        }
        const result = await removeWorktree({
          environmentId,
          input: { cwd: worktree.workspaceRoot, path: worktree.path, force: true },
        });
        if (result._tag === "Success") {
          refresh();
          return;
        }
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete worktree",
              description: failure instanceof Error ? failure.message : "An error occurred.",
            }),
          );
        }
      } finally {
        setBusyPaths((current) => {
          const next = new Set(current);
          next.delete(worktree.path);
          return next;
        });
      }
    },
    [environmentId, refresh, removeWorktree, runPrune],
  );

  const handleBulkPrune = useCallback(async () => {
    if (safeFiltered.length === 0 || isBulkPruning) return;
    const scope = filtersActive ? " matching the current filters" : "";
    if (
      !window.confirm(
        `Prune ${safeFiltered.length} safe ${safeFiltered.length === 1 ? "worktree" : "worktrees"}${scope}?\n\nOnly clean worktrees without active threads or unpushed work are removed. Branches are kept.`,
      )
    ) {
      return;
    }
    setIsBulkPruning(true);
    try {
      await runPrune(safeFiltered.map((worktree) => worktree.path));
    } finally {
      setIsBulkPruning(false);
    }
  }, [safeFiltered, filtersActive, isBulkPruning, runPrune]);

  const onDelete = useCallback(
    (worktree: WorktreeInfo) => {
      void handleDelete(worktree);
    },
    [handleDelete],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Worktrees"
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh worktrees"
              disabled={isPending}
              onClick={() => refresh()}
            >
              <RefreshCwIcon className={isPending ? "size-3.5 animate-spin" : "size-3.5"} />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 cursor-pointer gap-1.5 px-2.5"
              disabled={safeFiltered.length === 0 || isBulkPruning || environmentId === null}
              onClick={() => {
                void handleBulkPrune();
              }}
            >
              {isBulkPruning ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              <span>
                Prune {safeFiltered.length} safe{" "}
                {safeFiltered.length === 1 ? "worktree" : "worktrees"}
                {filtersActive ? " (filtered)" : ""}
              </span>
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-2 px-3 pb-1 sm:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search branch, folder, or thread…"
              className="h-8 w-full sm:max-w-xs"
            />
            {projectOptions.length > 1 ? (
              <Select
                value={projectFilter}
                onValueChange={(value) => setProjectFilter(value ?? ALL_PROJECTS)}
              >
                <SelectTrigger className="h-8 w-44">
                  <SelectValue placeholder="All projects" />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                  {projectOptions.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {STATUS_FILTERS.map((filter) => (
              <Button
                key={filter.key}
                type="button"
                variant={statusFilters.has(filter.key) ? "secondary" : "ghost"}
                size="sm"
                className="h-6 cursor-pointer rounded-full px-2.5 text-xs"
                onClick={() => toggleStatusFilter(filter.key)}
              >
                {filter.label}
              </Button>
            ))}
          </div>
        </div>

        {environmentId === null || filteredWorktrees.length === 0 ? (
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isPending ? (
                  <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <FolderGit2Icon className="size-3.5 text-muted-foreground" />
                )}
                {environmentId === null
                  ? "No environment connected"
                  : isPending
                    ? "Loading worktrees"
                    : error !== null
                      ? "Could not load worktrees"
                      : filtersActive
                        ? "No worktrees match the current filters"
                        : "No managed worktrees"}
              </span>
            }
            description={
              environmentId === null
                ? "Connect an environment to manage its worktrees."
                : error !== null
                  ? error
                  : "Worktrees created for threads will appear here."
            }
          />
        ) : null}
      </SettingsSection>

      {attentionWorktrees.length > 0 ? (
        <SettingsSection title="Needs attention">
          <p
            className={cn(
              "max-w-2xl px-3 pb-2 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4",
            )}
          >
            These worktrees have been inactive but still hold uncommitted changes or unpushed
            commits, so automatic pruning never touches them. Commit or push the work to make them
            safe, or force delete to discard it permanently.
          </p>
          <WorktreeTable
            worktrees={attentionWorktrees}
            showProject
            busyPaths={busyPaths}
            onDelete={onDelete}
          />
        </SettingsSection>
      ) : null}

      {remainingWorktrees.length > 0 ? (
        <SettingsSection
          title={attentionWorktrees.length > 0 ? "All worktrees" : "Managed worktrees"}
        >
          <WorktreeTable
            worktrees={remainingWorktrees}
            showProject
            busyPaths={busyPaths}
            onDelete={onDelete}
          />
        </SettingsSection>
      ) : null}

      <AutoPruneSettingsSection />
    </SettingsPageContainer>
  );
}

function AutoPruneSettingsSection() {
  const worktreeSettings = usePrimarySettings((settings) => settings.worktrees);
  const updateSettings = useUpdatePrimarySettings();

  const autoPruneValue =
    worktreeSettings.autoPruneAfterDays === null
      ? "off"
      : String(worktreeSettings.autoPruneAfterDays);

  return (
    <SettingsSection title="Automatic pruning">
      <SettingsRow
        title="Prune inactive worktrees"
        description="Automatically delete worktrees that are safe to prune — no active threads, no uncommitted changes, and no unpushed commits — once they have been inactive this long. Branches are always kept."
        control={
          <Select
            value={autoPruneValue}
            onValueChange={(value) => {
              updateSettings({
                worktrees: {
                  autoPruneAfterDays: value === "off" || value === null ? null : Number(value),
                },
              });
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="After 14 days" />
            </SelectTrigger>
            <SelectPopup>
              {AUTO_PRUNE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Delete orphaned worktrees immediately"
        description="When the last thread using a worktree is deleted, remove the worktree right away instead of waiting for the inactivity schedule. Only applies to worktrees that are safe to prune."
        control={
          <Switch
            checked={worktreeSettings.deleteOrphanedImmediately}
            onCheckedChange={(checked) => {
              updateSettings({ worktrees: { deleteOrphanedImmediately: checked === true } });
            }}
          />
        }
      />
    </SettingsSection>
  );
}
