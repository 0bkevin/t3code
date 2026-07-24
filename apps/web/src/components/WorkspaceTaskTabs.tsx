import { CircleDashedIcon, GitForkIcon, InfoIcon, PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { shortcutLabelForCommand } from "../keybindings";
import { useClientSettings } from "../hooks/useSettings";
import { type WorkspaceTaskTab, useWorkspaceTaskTabs } from "../hooks/useWorkspaceTaskTabs";
import {
  TASK_TABS_SHARED_SCOPE_EXPLANATION,
  describeTaskTabContexts,
  type TaskTabContextDescriptor,
} from "../lib/taskTabContext";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

function tabThreadId(tab: WorkspaceTaskTab): string {
  return String(tab.kind === "server" ? tab.threadRef.threadId : tab.threadId);
}

/**
 * State is carried by shape and text as well as hue: blocked tabs get a filled
 * ring plus "Waiting on you", working tabs get a dashed spinner glyph. Colour
 * is the accent, never the only signal.
 */
function TabStateGlyph(props: { tab: WorkspaceTaskTab }) {
  const { tab } = props;
  if (tab.blocked) {
    return (
      <span
        role="img"
        aria-label="Waiting on you"
        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-amber-500 text-amber-600 dark:text-amber-400"
      >
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
      </span>
    );
  }
  if (tab.working) {
    // Duty-cycled steps() pulse from index.css, not a continuous spin: this
    // strip can be on screen for hours on a 120Hz display.
    return (
      <CircleDashedIcon
        role="img"
        aria-label="Working"
        className="size-3.5 shrink-0 animate-status-pulse text-sky-600 motion-reduce:animate-none dark:text-sky-400"
      />
    );
  }
  return null;
}

function contextChipClass(kind: TaskTabContextDescriptor["kind"], active: boolean): string {
  if (!active) return "border-border/30 bg-background/30 text-muted-foreground/60";
  return kind === "snapshot"
    ? "border-border/60 bg-muted/80 text-muted-foreground/90"
    : "border-border/45 bg-muted/60 text-muted-foreground/75";
}

export function WorkspaceTaskTabs() {
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const { tabs, keybindings, hasTask, canForkContext, createTab, closeTab, navigateToTab } =
    useWorkspaceTaskTabs();
  const [creatingMode, setCreatingMode] = useState<"fresh" | "portable" | null>(null);
  const contexts = useMemo(
    () =>
      describeTaskTabContexts(
        tabs.map((tab) => ({
          kind: tab.kind,
          threadId: tabThreadId(tab),
          title: tab.title,
          position: tab.position,
          forkProvenance: tab.forkProvenance
            ? {
                mode: tab.forkProvenance.mode,
                sourceThreadId:
                  tab.forkProvenance.sourceThreadId === null
                    ? null
                    : String(tab.forkProvenance.sourceThreadId),
              }
            : null,
        })),
      ),
    [tabs],
  );

  if (!sidebarV2Enabled || !hasTask) return null;

  const newTabShortcut = shortcutLabelForCommand(keybindings, "chat.newTab");
  const create = (mode: "fresh" | "portable") => {
    if (creatingMode !== null) return;
    setCreatingMode(mode);
    void createTab(mode).finally(() => setCreatingMode(null));
  };

  return (
    <TooltipProvider delay={250} closeDelay={0}>
      <nav
        aria-label="Task tabs"
        data-testid="workspace-task-tabs"
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 sm:px-5"
      >
        {/* One segmented control, not browser chrome: the tabs sit inside a
            single inset track so the strip reads as a compact control. */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md bg-muted/40 p-0.5 [scrollbar-width:none]">
          {tabs.map((tab, index) => {
            const context = contexts[index];
            return (
              <div
                key={tab.key}
                className={cn(
                  "group/task-tab relative flex h-7 max-w-64 min-w-0 shrink-0 items-center rounded-[5px] pr-1 pl-2 text-xs transition-colors",
                  tab.active
                    ? "bg-background text-foreground shadow-xs ring-1 ring-border/70"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
                        onClick={() => void navigateToTab(tab)}
                        aria-current={tab.active ? "page" : undefined}
                      />
                    }
                  >
                    <TabStateGlyph tab={tab} />
                    {tab.forkProvenance?.mode === "portable" ? (
                      <GitForkIcon aria-hidden className="size-3 shrink-0 opacity-45" />
                    ) : null}
                    <span className="truncate font-medium">
                      {context?.title ?? tab.title}
                      {/* Context stays legible to assistive tech even when the
                          chip is hidden at narrow widths. */}
                      {context ? <span className="sr-only"> — {context.label}</span> : null}
                    </span>
                    {context ? (
                      <span
                        aria-hidden
                        className={cn(
                          "hidden max-w-40 shrink-0 truncate rounded-sm border px-1 py-px text-[9px] leading-3.5 font-normal whitespace-nowrap md:inline-block",
                          contextChipClass(context.kind, tab.active),
                        )}
                      >
                        {context.label}
                      </span>
                    ) : null}
                  </TooltipTrigger>
                  <TooltipPopup side="bottom" className="max-w-72">
                    <span className="block px-0.5 py-0.5 text-left leading-relaxed whitespace-normal">
                      <span className="font-medium text-foreground">
                        {context?.label ?? "Own context"}
                      </span>
                      {context ? (
                        <span className="mt-0.5 block text-muted-foreground">{context.detail}</span>
                      ) : null}
                    </span>
                  </TooltipPopup>
                </Tooltip>
                {tabs.length > 1 && tab.position > 0 ? (
                  <button
                    type="button"
                    aria-label={`Close ${context?.title ?? tab.title}`}
                    disabled={tab.working || tab.blocked}
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeTab(tab);
                    }}
                    className="ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-20 group-hover/task-tab:opacity-100"
                  >
                    <XIcon className="size-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="New task tab"
                  disabled={creatingMode !== null}
                  onClick={() => create("fresh")}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                />
              }
            >
              <PlusIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              New empty tab{newTabShortcut ? ` (${newTabShortcut})` : ""}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Fork context into a new task tab"
                  disabled={!canForkContext || creatingMode !== null}
                  onClick={() => create("portable")}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-35"
                />
              }
            >
              <GitForkIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-64">
              <span className="block py-0.5 text-left whitespace-normal">
                {canForkContext
                  ? "New tab seeded with a one-time snapshot of this tab's conversation"
                  : "Send the first message before forking context"}
              </span>
            </TooltipPopup>
          </Tooltip>
          {/* Stated once for the whole task, so individual tabs don't need to
              repeat the shared-worktree / separate-history caveat. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="How task tabs share context"
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
                />
              }
            >
              <InfoIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom" align="end" className="max-w-72">
              <span className="block py-0.5 text-left leading-relaxed whitespace-normal">
                {TASK_TABS_SHARED_SCOPE_EXPLANATION}
              </span>
            </TooltipPopup>
          </Tooltip>
        </div>
      </nav>
    </TooltipProvider>
  );
}
