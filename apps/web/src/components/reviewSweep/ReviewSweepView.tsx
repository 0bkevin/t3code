import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { hasQueuedTurnStart } from "@t3tools/client-runtime/state/thread-settled";
import { createModelSelection } from "@t3tools/shared/model";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleAlertIcon,
  GitMergeIcon,
  InfoIcon,
  ListChecksIcon,
  LoaderIcon,
  PencilLineIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { useClientSettings, usePrimarySettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  applyAllSweepRecommendations,
  applySweepSettle,
  applySweepTitle,
  dismissSweepItem,
  isSweepCandidate,
  mergeSweepItem,
  readSweepModelSelection,
  retrySweepItem,
  setSweepModelSelection,
  runMergeQueue,
  sortSweepCandidates,
  startReviewSweep,
  SWEEP_MAX_THREADS,
  sweepNowIso,
  useReviewSweepStore,
  type SweepItem,
} from "../../reviewSweepStore";
import {
  readThreadShell,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

// ---------------------------------------------------------------------------
// Triage buckets: ordered by "how fast can you clear this" — one-click
// settles first, quick title fixes second, then threads that need real
// reading, then no-action-possible tails.
// ---------------------------------------------------------------------------

type SweepBucket =
  | "mergeReady"
  | "settle"
  | "title"
  | "attention"
  | "inFlight"
  | "failed"
  | "reviewing";

const BUCKET_ORDER: readonly SweepBucket[] = [
  "mergeReady",
  "settle",
  "title",
  "attention",
  "inFlight",
  "failed",
  "reviewing",
];

const BUCKET_META: Record<
  SweepBucket,
  { title: string; hint: string; accent: string; icon: typeof ArchiveIcon }
> = {
  mergeReady: {
    title: "Merge ready",
    hint: "Open PRs with green CI, approvals, and clean merges.",
    accent: "border-s-violet-500/70",
    icon: GitMergeIcon,
  },
  settle: {
    title: "Ready to settle",
    hint: "Work concluded — one click clears each from your active list.",
    accent: "border-s-emerald-500/70",
    icon: ArchiveIcon,
  },
  title: {
    title: "Title fixes",
    hint: "Still in progress, but the name no longer matches the work.",
    accent: "border-s-sky-500/70",
    icon: PencilLineIcon,
  },
  attention: {
    title: "Needs your attention",
    hint: "Waiting on you — review, input, or a decision.",
    accent: "border-s-amber-500/70",
    icon: CircleAlertIcon,
  },
  inFlight: {
    title: "In flight",
    hint: "Agents are still working; nothing to do yet.",
    accent: "border-s-border",
    icon: LoaderIcon,
  },
  failed: {
    title: "Review failed",
    hint: "The reviewer couldn't process these — retry or open them directly.",
    accent: "border-s-red-500/70",
    icon: CircleAlertIcon,
  },
  reviewing: {
    title: "Still reviewing",
    hint: "",
    accent: "border-s-border",
    icon: LoaderIcon,
  },
};

function classifySweepItem(item: SweepItem): SweepBucket {
  if (item.status === "error") return "failed";
  if (item.status !== "done" || item.result === null) return "reviewing";
  // Merge-ready wins over everything: it's the highest-leverage one-click.
  // Items stay in the bucket through the queue lifecycle (queued → merging
  // → merged/conflicted) so progress is visible in place.
  if (item.result.prStatus?.mergeReady && !item.settleApplied) return "mergeReady";
  if (item.result.recommendSettle && !item.settleApplied) return "settle";
  if (item.result.suggestedTitle && !item.titleApplied) return "title";
  // Live shell wins over review-time knowledge: a thread blocked on the user
  // right now belongs in "attention" even if the review predates the block.
  const shell = readThreadShell(item.ref);
  const working =
    shell?.session?.status === "running" ||
    shell?.session?.status === "starting" ||
    // A just-sent message no session has adopted yet is in-flight work, not
    // something waiting on the user.
    (shell !== null && hasQueuedTurnStart(shell, { now: new Date().toISOString() }));
  const blocked = shell?.hasPendingApprovals === true || shell?.hasPendingUserInput === true;
  if (blocked) return "attention";
  if (working) return "inFlight";
  return "attention";
}

function DiffStatsLabel({ item }: { item: SweepItem }) {
  const stats = item.result?.diffStats;
  if (!stats || stats.files === 0) return null;
  return (
    <span className="flex items-center gap-1 font-mono text-[11px]">
      <span className="text-emerald-500">+{stats.additions}</span>
      <span className="text-red-400">−{stats.deletions}</span>
      <span className="text-muted-foreground/70">
        · {stats.files} {stats.files === 1 ? "file" : "files"}
      </span>
    </span>
  );
}

function SweepItemMetaRow({
  item,
  projectTitle,
  workspaceRoot,
}: {
  item: SweepItem;
  projectTitle: string;
  workspaceRoot: string | null;
}) {
  const age = formatRelativeTimeLabel(item.lastActivityAt);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5">
        {workspaceRoot ? (
          <ProjectFavicon
            environmentId={item.ref.environmentId}
            cwd={workspaceRoot}
            className="size-3.5 shrink-0"
          />
        ) : null}
        <span className="truncate">{projectTitle}</span>
      </span>
      {item.branch ? (
        <span className="max-w-56 truncate font-mono text-[11px] text-muted-foreground/80">
          {item.branch}
        </span>
      ) : null}
      {item.result?.prStatus ? (
        <a
          href={item.result.prStatus.url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          #{item.result.prStatus.number}
        </a>
      ) : null}
      {age ? <span className="shrink-0">{age}</span> : null}
      <DiffStatsLabel item={item} />
    </div>
  );
}

function MergeStatusBadge({ item }: { item: SweepItem }) {
  switch (item.mergeStatus) {
    case "queued":
      return <Badge variant="secondary">Queued</Badge>;
    case "merging":
      return (
        <Badge variant="info">
          <Spinner className="me-1 size-3" />
          Merging
        </Badge>
      );
    case "merged":
      return <Badge variant="success">Merged</Badge>;
    case "conflicted":
      return <Badge variant="warning">Conflict — agent rebasing</Badge>;
    case "failed":
      return <Badge variant="error">Merge failed</Badge>;
    default:
      return null;
  }
}

function SweepItemCard({
  item,
  bucket,
  projectTitle,
  workspaceRoot,
}: {
  item: SweepItem;
  bucket: SweepBucket;
  projectTitle: string;
  workspaceRoot: string | null;
}) {
  const key = scopedThreadKey(item.ref);
  const [applying, setApplying] = useState(false);
  const result = item.result;
  const meta = BUCKET_META[bucket];

  const primaryAction =
    bucket === "mergeReady" ? (
      item.mergeStatus === "idle" || item.mergeStatus === "failed" ? (
        <Button
          size="xs"
          variant="outline"
          className="shrink-0"
          disabled={applying}
          onClick={() => {
            setApplying(true);
            void mergeSweepItem(key).finally(() => setApplying(false));
          }}
        >
          <GitMergeIcon className="me-1 size-3.5" />
          Merge & settle
        </Button>
      ) : null
    ) : bucket === "settle" ? (
      <Button
        size="xs"
        variant="outline"
        className="shrink-0"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          void applySweepSettle(key).finally(() => setApplying(false));
        }}
      >
        <ArchiveIcon className="me-1 size-3.5" />
        Settle
      </Button>
    ) : bucket === "title" ? (
      <Button
        size="xs"
        variant="outline"
        className="shrink-0"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          void applySweepTitle(key).finally(() => setApplying(false));
        }}
      >
        Apply title
      </Button>
    ) : bucket === "failed" ? (
      <Button size="xs" variant="outline" className="shrink-0" onClick={() => retrySweepItem(key)}>
        Retry
      </Button>
    ) : null;

  // The one-line "what should I do" is the card body; the full summary
  // lives behind the info icon so the grid stays scannable. Results from
  // pre-nextStep servers fall back to settleReason (settle bucket) or the
  // summary (attention bucket) so action cards never render bodyless.
  const nextStepFallback =
    bucket === "settle"
      ? (result?.settleReason ?? null)
      : bucket === "attention"
        ? (result?.summary ?? null)
        : null;
  const nextStep = item.status === "error" ? null : (result?.nextStep ?? nextStepFallback);

  return (
    <Card className={cn("min-w-0 gap-1.5 border-s-2 p-3", meta.accent)}>
      <div className="flex items-center gap-1.5">
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(item.ref)}
          className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
        >
          {item.threadTitle}
        </Link>
        {bucket === "settle" && item.settleApplied ? (
          <Badge variant="outline">Settled</Badge>
        ) : null}
        {bucket === "mergeReady" ? <MergeStatusBadge item={item} /> : null}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {result?.summary ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground/70"
                    aria-label="Show thread summary"
                  />
                }
              >
                <InfoIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom" className="max-w-80">
                {result.summary}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground"
            aria-label="Dismiss recommendation"
            onClick={() => dismissSweepItem(key)}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <SweepItemMetaRow item={item} projectTitle={projectTitle} workspaceRoot={workspaceRoot} />

      {item.status === "error" ? (
        <p className="line-clamp-2 text-sm text-red-400/90">{item.errorMessage}</p>
      ) : item.mergeStatus === "conflicted" || item.mergeStatus === "failed" ? (
        <p className="line-clamp-2 text-sm text-warning-foreground">{item.mergeDetail}</p>
      ) : nextStep ? (
        <p className="line-clamp-2 text-sm text-foreground/90">{nextStep}</p>
      ) : null}

      {bucket === "title" && result?.suggestedTitle ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <span className="max-w-full truncate text-muted-foreground/70 line-through">
            {item.threadTitle}
          </span>
          <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground/70" />
          <span className="max-w-full truncate font-medium text-foreground">
            {result.suggestedTitle}
          </span>
        </div>
      ) : null}
      {result?.suggestedTitle && item.titleApplied ? (
        <p className="truncate text-xs text-muted-foreground">
          Renamed to <span className="font-medium text-foreground">{result.suggestedTitle}</span>.
        </p>
      ) : null}

      {primaryAction ? <div className="flex justify-end pt-0.5">{primaryAction}</div> : null}
    </Card>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** Live per-thread progress: what's running, for how long, and what each
    review cost. Replaces a bare spinner so a multi-minute sweep is
    legible while it works. */
function SweepProgressList({
  items,
  projectsByKey,
}: {
  items: ReadonlyArray<SweepItem>;
  projectsByKey: ReadonlyMap<string, { title: string; workspaceRoot: string }>;
}) {
  // Ticking clock so elapsed times advance without store writes.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Running first (that's the live part), then queued, then finished.
  const ordered = useMemo(() => {
    const rank = (item: SweepItem) =>
      item.status === "running" ? 0 : item.status === "pending" ? 1 : 2;
    return [...items].sort((a, b) => rank(a) - rank(b));
  }, [items]);

  return (
    <div className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60">
      {ordered.map((item) => {
        const project = projectsByKey.get(
          scopedProjectKey(scopeProjectRef(item.ref.environmentId, item.projectId)),
        );
        const elapsedMs =
          item.startedAtMs === null ? null : (item.finishedAtMs ?? nowMs) - item.startedAtMs;
        const usage = item.result?.usage;
        return (
          <div
            key={scopedThreadKey(item.ref)}
            className={cn(
              "flex items-center gap-3 px-3 py-2 text-sm",
              item.status === "pending" && "opacity-50",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {item.status === "running" ? (
                <Spinner className="size-3.5 text-sky-400" />
              ) : item.status === "done" ? (
                <CheckIcon className="size-3.5 text-emerald-500" />
              ) : item.status === "error" ? (
                <CircleAlertIcon className="size-3.5 text-red-400" />
              ) : (
                <span className="size-1.5 rounded-full bg-muted-foreground/40" />
              )}
            </span>
            {project?.workspaceRoot ? (
              <ProjectFavicon
                environmentId={item.ref.environmentId}
                cwd={project.workspaceRoot}
                className="size-3.5 shrink-0"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-foreground/90">{item.threadTitle}</span>
            {usage ? (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {formatTokens(usage.inputTokens + usage.outputTokens)} tok
                {usage.costUsd !== undefined ? ` · $${usage.costUsd.toFixed(2)}` : ""}
              </span>
            ) : null}
            <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
              {elapsedMs === null ? "—" : formatDuration(elapsedMs)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Cost-transparency threshold: at or above this many candidate threads the
    pre-run screen calls out that the sweep may be slow/expensive. */
const SWEEP_COST_NOTE_THRESHOLD = 15;

/** Pre-run summary: how many threads a sweep would cover and which model
    each environment's server will use, so starting is an informed choice.
    Rendered on the idle /review-sweep page and inside the sidebar's launch
    modal. `onStarted` lets the modal close itself when the sweep kicks off. */
export function SweepPreRunSummary({ onStarted }: { onStarted?: () => void } = {}) {
  const shells = useThreadShells();
  const serverConfigs = useServerConfigs();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  // Recompute when the sidebar publishes fresh PR states — merged-PR
  // auto-settle changes which threads count as unsettled.
  const candidateVersion = useReviewSweepStore((state) => state.candidateVersion);

  // Review model: defaults to the composer's last-used pick, overridable
  // here. Re-read on candidateVersion so the trigger reflects changes.
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const settings = usePrimarySettings();
  const selectedModel = useMemo(
    () => readSweepModelSelection(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- module-level source
    [candidateVersion],
  );
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const activeInstanceId = selectedModel?.instanceId ?? instanceEntries[0]?.instanceId ?? null;
  const activeModel = selectedModel?.model ?? instanceEntries[0]?.models[0]?.slug ?? "";
  const activeOptions = selectedModel?.options ?? [];
  const modelOptionsByInstance = useMemo(
    () =>
      activeInstanceId === null
        ? new Map()
        : getCustomModelOptionsByInstance(settings, serverProviders, activeInstanceId, activeModel),
    [activeInstanceId, activeModel, serverProviders, settings],
  );
  const activeInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === activeInstanceId,
  );

  const { candidateCount, reviewedCount, modelsByEnvironment } = useMemo(() => {
    const now = sweepNowIso();
    const candidates = sortSweepCandidates(
      shells.filter((shell) =>
        isSweepCandidate(shell, serverConfigs.get(shell.environmentId)?.environment.capabilities, {
          now,
          autoSettleAfterDays,
        }),
      ),
    );
    // Aggregate only what a run would actually review: the cap is applied
    // here, in the same most-recently-active order startReviewSweep uses,
    // so the environment/model rows never overstate the calls.
    const reviewed = candidates.slice(0, SWEEP_MAX_THREADS);
    const models = new Map<
      string,
      { environmentId: string; label: string; model: string; threads: number }
    >();
    for (const shell of reviewed) {
      const config = serverConfigs.get(shell.environmentId);
      const entry = models.get(shell.environmentId);
      if (entry) {
        entry.threads += 1;
      } else {
        const selection = config?.settings.textGenerationModelSelection;
        models.set(shell.environmentId, {
          environmentId: shell.environmentId,
          label: config?.environment.label ?? shell.environmentId,
          model: selection ? `${selection.model}` : "server default",
          threads: 1,
        });
      }
    }
    return {
      candidateCount: candidates.length,
      reviewedCount: reviewed.length,
      modelsByEnvironment: [...models.values()],
    };
  }, [autoSettleAfterDays, candidateVersion, serverConfigs, shells]);

  if (candidateCount === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>All caught up</EmptyTitle>
          <EmptyDescription>No unsettled threads to review right now.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Review your in-progress work</EmptyTitle>
        <EmptyDescription>
          This sweep runs one AI review per thread to summarize it, catch stale titles, and find
          threads ready to settle. Nothing is applied without your click.
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex w-full max-w-md flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">{reviewedCount}</span>{" "}
          {reviewedCount === 1 ? "thread" : "threads"} will be reviewed
          {candidateCount > SWEEP_MAX_THREADS
            ? ` (${candidateCount - SWEEP_MAX_THREADS} least-recently-active skipped)`
            : ""}
        </div>
        {modelsByEnvironment.length > 1 ? (
          <div className="truncate">
            Across{" "}
            {modelsByEnvironment.map((entry, index) => (
              <span key={entry.environmentId}>
                {index > 0 ? ", " : ""}
                {entry.label} ({entry.threads})
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <span className="shrink-0">Review with</span>
          {activeInstanceId !== null ? (
            <>
              <ProviderModelPicker
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) => {
                  // Carry the current traits across a model switch when the
                  // instance is unchanged; a different instance's options
                  // aren't transferable, so start clean there.
                  setSweepModelSelection(
                    createModelSelection(
                      instanceId,
                      model,
                      instanceId === activeInstanceId ? activeOptions : undefined,
                    ),
                  );
                }}
              />
              {activeInstanceEntry ? (
                <TraitsPicker
                  provider={activeInstanceEntry.driverKind}
                  models={activeInstanceEntry.models}
                  model={activeModel}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={activeOptions}
                  allowPromptInjectedEffort={false}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onModelOptionsChange={(nextOptions) => {
                    setSweepModelSelection(
                      createModelSelection(activeInstanceId, activeModel, nextOptions),
                    );
                  }}
                />
              ) : null}
            </>
          ) : (
            <span className="text-foreground">server default</span>
          )}
        </div>
        {reviewedCount >= SWEEP_COST_NOTE_THRESHOLD ? (
          <div className="text-warning-foreground">
            Heads up: {reviewedCount} model calls may take a few minutes and use noticeable credits.
          </div>
        ) : null}
      </div>
      <Button
        size="sm"
        onClick={() => {
          startReviewSweep();
          onStarted?.();
        }}
      >
        <ListChecksIcon className="me-1.5 size-4" />
        Review {reviewedCount} {reviewedCount === 1 ? "thread" : "threads"}
      </Button>
    </Empty>
  );
}

export function ReviewSweepView() {
  const phase = useReviewSweepStore((state) => state.phase);
  const order = useReviewSweepStore((state) => state.order);
  const items = useReviewSweepStore((state) => state.items);
  const truncatedCount = useReviewSweepStore((state) => state.truncatedCount);
  const projects = useProjects();
  // classifySweepItem reads live shells (running vs blocked), so bucketing
  // must recompute when shells change and not only when items do.
  const shells = useThreadShells();

  // Projects are only unique per (environmentId, projectId) — ids can
  // collide across connected environments.
  const projectsByKey = useMemo(() => {
    const byKey = new Map<string, { title: string; workspaceRoot: string }>();
    for (const project of projects) {
      byKey.set(scopedProjectKey(scopeProjectRef(project.environmentId, project.id)), {
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      });
    }
    return byKey;
  }, [projects]);

  const visibleItems = useMemo(
    () =>
      order
        .map((key) => items[key])
        .filter((item): item is SweepItem => item !== undefined && !item.dismissed),
    [items, order],
  );

  const buckets = useMemo(() => {
    const grouped = new Map<SweepBucket, SweepItem[]>();
    for (const item of visibleItems) {
      const bucket = classifySweepItem(item);
      const group = grouped.get(bucket);
      if (group) {
        group.push(item);
      } else {
        grouped.set(bucket, [item]);
      }
    }
    // Within a bucket, smallest diff first — clear the easy ones, build
    // momentum. Unknown diff sizes sink to the bottom.
    for (const group of grouped.values()) {
      group.sort((a, b) => {
        const sizeOf = (item: SweepItem) => {
          const stats = item.result?.diffStats;
          return stats ? stats.additions + stats.deletions : Number.MAX_SAFE_INTEGER;
        };
        return sizeOf(a) - sizeOf(b);
      });
    }
    return BUCKET_ORDER.flatMap((bucket) => {
      const group = grouped.get(bucket);
      return group && group.length > 0 ? [[bucket, group] as const] : [];
    });
    // `shells` is a classification input via readThreadShell, not unused.
  }, [shells, visibleItems]);

  const reviewedCount = visibleItems.filter(
    (item) => item.status === "done" || item.status === "error",
  ).length;
  const applicableCount = visibleItems.filter(
    (item) =>
      (item.result?.suggestedTitle && !item.titleApplied) ||
      (item.result?.recommendSettle && !item.settleApplied),
  ).length;
  const running = phase === "running";
  const [applyingAll, setApplyingAll] = useState(false);
  const [mergingAll, setMergingAll] = useState(false);
  // Aggregate what the run has cost so far, from provider-reported usage.
  const runTotals = useMemo(
    () =>
      visibleItems.reduce(
        (totals, item) => {
          const usage = item.result?.usage;
          if (!usage) return totals;
          return {
            tokens: totals.tokens + usage.inputTokens + usage.outputTokens,
            costUsd: totals.costUsd + (usage.costUsd ?? 0),
          };
        },
        { tokens: 0, costUsd: 0 },
      ),
    [visibleItems],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "border-b border-border/60 px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex min-h-7 items-center gap-3 sm:min-h-6">
            <span className="text-sm font-medium text-foreground">Work review</span>
            {phase !== "idle" ? (
              <span className="text-xs text-muted-foreground">
                {running ? (
                  <>
                    {reviewedCount} of {visibleItems.length} reviewed
                  </>
                ) : (
                  <>{visibleItems.length} threads reviewed</>
                )}
              </span>
            ) : null}
            {phase !== "idle" ? (
              <div className="ms-auto flex items-center gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={running}
                  onClick={() => startReviewSweep()}
                >
                  <RotateCcwIcon className="mx-1 size-3.5" />
                  Re-run
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={running || applyingAll || applicableCount === 0}
                  onClick={() => {
                    setApplyingAll(true);
                    void applyAllSweepRecommendations().finally(() => setApplyingAll(false));
                  }}
                >
                  Apply all{applicableCount > 0 ? ` (${applicableCount})` : ""}
                </Button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
          {phase === "idle" ? (
            <SweepPreRunSummary />
          ) : running ? (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="text-sm font-medium text-foreground">
                    Reviewing your work — {reviewedCount} of {visibleItems.length}
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    {runTotals.tokens > 0 ? `${formatTokens(runTotals.tokens)} tokens` : null}
                    {runTotals.costUsd > 0 ? ` · $${runTotals.costUsd.toFixed(2)}` : ""}
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-sky-500 transition-[width] duration-500"
                    style={{
                      width: `${visibleItems.length === 0 ? 0 : Math.round((reviewedCount / visibleItems.length) * 100)}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Results appear all at once when every thread is reviewed, so you can triage in one
                  pass. Feel free to navigate away; the sweep keeps running.
                </p>
              </div>
              <SweepProgressList items={visibleItems} projectsByKey={projectsByKey} />
            </div>
          ) : visibleItems.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>All caught up</EmptyTitle>
                <EmptyDescription>No unsettled threads to review right now.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <TooltipProvider>
              <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
                {truncatedCount > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Reviewed the {visibleItems.length} most recent threads; {truncatedCount} more
                    were skipped this run.
                  </p>
                ) : null}
                {buckets.map(([bucket, bucketItems]) => {
                  const meta = BUCKET_META[bucket];
                  const BucketIcon = meta.icon;
                  const mergeableCount =
                    bucket === "mergeReady"
                      ? bucketItems.filter(
                          (item) => item.mergeStatus === "idle" || item.mergeStatus === "queued",
                        ).length
                      : 0;
                  return (
                    <section key={bucket} className="flex flex-col gap-2">
                      <div className="flex items-baseline gap-2">
                        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground/80">
                          <BucketIcon className="size-3.5" />
                          {meta.title}
                          <span className="font-normal text-muted-foreground">
                            · {bucketItems.length}
                          </span>
                        </h2>
                        {meta.hint ? (
                          <span className="truncate text-xs text-muted-foreground/70">
                            {meta.hint}
                          </span>
                        ) : null}
                        {bucket === "mergeReady" && mergeableCount > 0 ? (
                          <Button
                            size="xs"
                            variant="outline"
                            className="ms-auto shrink-0"
                            disabled={mergingAll}
                            onClick={() => {
                              setMergingAll(true);
                              void runMergeQueue().finally(() => setMergingAll(false));
                            }}
                          >
                            <GitMergeIcon className="me-1 size-3.5" />
                            Merge all ({mergeableCount})
                          </Button>
                        ) : null}
                      </div>
                      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                        {bucketItems.map((item) => {
                          const projectKey = scopedProjectKey(
                            scopeProjectRef(item.ref.environmentId, item.projectId),
                          );
                          const project = projectsByKey.get(projectKey);
                          return (
                            <SweepItemCard
                              key={scopedThreadKey(item.ref)}
                              item={item}
                              bucket={bucket}
                              projectTitle={project?.title ?? "Unknown project"}
                              workspaceRoot={project?.workspaceRoot ?? null}
                            />
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            </TooltipProvider>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
