import { GitForkIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { shortcutLabelForCommand } from "../keybindings";
import { useClientSettings } from "../hooks/useSettings";
import { type WorkspaceTaskTab, useWorkspaceTaskTabs } from "../hooks/useWorkspaceTaskTabs";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

function tabStatusClass(tab: WorkspaceTaskTab): string {
  if (tab.blocked) return "bg-amber-500";
  if (tab.working) return "animate-pulse bg-sky-500 motion-reduce:animate-none";
  return "bg-muted-foreground/35";
}

export function WorkspaceTaskTabs() {
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const { tabs, keybindings, hasTask, canForkContext, createTab, closeTab, navigateToTab } =
    useWorkspaceTaskTabs();
  const [creatingMode, setCreatingMode] = useState<"fresh" | "portable" | null>(null);

  if (!sidebarV2Enabled || !hasTask) return null;

  const newTabShortcut = shortcutLabelForCommand(keybindings, "chat.newTab");
  const workingCount = tabs.filter((tab) => tab.working).length;
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
        className="flex h-10 shrink-0 items-end gap-1 border-b border-border/70 bg-background px-3 sm:px-5"
      >
        <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {tabs.map((tab, index) => (
            <div
              key={tab.key}
              className={cn(
                "group/task-tab relative flex h-9 max-w-56 min-w-24 shrink-0 items-center rounded-t-md border border-b-0 px-2.5 text-xs transition-colors",
                tab.active
                  ? "border-border bg-card text-foreground shadow-[0_-1px_8px_hsl(var(--foreground)/0.03)]"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
                onClick={() => void navigateToTab(tab)}
                aria-current={tab.active ? "page" : undefined}
              >
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", tabStatusClass(tab))}
                />
                <span className="truncate">
                  {index === 0 && tab.title === "Tab 1" ? "Main" : tab.title}
                </span>
                {tab.forkProvenance?.mode === "portable" ? (
                  <GitForkIcon aria-label="Context fork" className="size-3 shrink-0 opacity-50" />
                ) : null}
              </button>
              {tabs.length > 1 && tab.position > 0 ? (
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  disabled={tab.working || tab.blocked}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(tab);
                  }}
                  className="ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-20 group-hover/task-tab:opacity-100"
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-0.5 pb-1">
          {workingCount > 0 ? (
            <span
              role="status"
              className={cn(
                "mr-1 hidden whitespace-nowrap font-mono text-[10px] sm:inline",
                workingCount > 1 ? "text-amber-600 dark:text-amber-400" : "text-sky-600",
              )}
              title="Agents in this task share one worktree"
            >
              {workingCount} running · shared tree
            </span>
          ) : null}
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
              New tab{newTabShortcut ? ` (${newTabShortcut})` : ""}
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
            <TooltipPopup side="bottom">
              {canForkContext
                ? "Fork this tab’s context into a new tab"
                : "Send the first message before forking context"}
            </TooltipPopup>
          </Tooltip>
        </div>
      </nav>
    </TooltipProvider>
  );
}
