import {
  CircleDashedIcon,
  CopyPlusIcon,
  HistoryIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { shortcutLabelForCommand } from "../keybindings";
import { useClientSettings } from "../hooks/useSettings";
import {
  type ClosedWorkspaceTaskTab,
  type WorkspaceTaskTab,
  useWorkspaceTaskTabs,
} from "../hooks/useWorkspaceTaskTabs";
import {
  describeTaskTabContexts,
  type TaskTabContextDescriptor,
  type TaskTabContextSource,
} from "../lib/taskTabContext";
import { cn } from "../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type AnyWorkspaceTaskTab = WorkspaceTaskTab | ClosedWorkspaceTaskTab;

function tabContextSource(tab: AnyWorkspaceTaskTab): TaskTabContextSource {
  return {
    kind: tab.kind,
    threadId: String(tab.kind === "server" ? tab.threadRef.threadId : tab.threadId),
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
  };
}

/**
 * State is carried by shape and text as well as hue: blocked tabs get a filled
 * ring plus "Waiting on you", working tabs get a dashed spinner glyph.
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

function ContextSummary(props: {
  context: TaskTabContextDescriptor;
  active: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "hidden shrink-0 truncate text-[10px] font-normal whitespace-nowrap md:inline",
        props.active ? "text-muted-foreground/80" : "text-muted-foreground/55",
        props.className,
      )}
    >
      · {props.context.label}
    </span>
  );
}

export function WorkspaceTaskTabs() {
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const {
    tabs,
    closedTabs,
    keybindings,
    hasTask,
    canForkContext,
    createTab,
    closeTab,
    reopenTab,
    navigateToTab,
  } = useWorkspaceTaskTabs();
  const [creatingMode, setCreatingMode] = useState<"fresh" | "portable" | null>(null);
  const [reopeningKey, setReopeningKey] = useState<string | null>(null);
  const contextByTabKey = useMemo(() => {
    const allTabs = [...tabs, ...closedTabs];
    const contexts = describeTaskTabContexts(allTabs.map(tabContextSource));
    return new Map(allTabs.map((tab, index) => [tab.key, contexts[index]!]));
  }, [closedTabs, tabs]);

  if (!sidebarV2Enabled || !hasTask) return null;

  const newTabShortcut = shortcutLabelForCommand(keybindings, "chat.newTab");
  const reopenShortcut = shortcutLabelForCommand(keybindings, "chat.reopenClosedTab");
  const create = (mode: "fresh" | "portable") => {
    if (creatingMode !== null) return;
    setCreatingMode(mode);
    void createTab(mode).finally(() => setCreatingMode(null));
  };
  const reopen = (tab: ClosedWorkspaceTaskTab) => {
    if (reopeningKey !== null) return;
    setReopeningKey(tab.key);
    void reopenTab(tab).finally(() => setReopeningKey(null));
  };

  return (
    <TooltipProvider delay={250} closeDelay={0}>
      <nav
        aria-label="Task tabs"
        data-testid="workspace-task-tabs"
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 sm:px-5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md bg-muted/40 p-0.5 [scrollbar-width:none]">
          {tabs.map((tab) => {
            const context = contextByTabKey.get(tab.key);
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
                    <span className="truncate font-medium">
                      {context?.title ?? tab.title}
                      {context ? <span className="sr-only"> — {context.label}</span> : null}
                    </span>
                    {context ? <ContextSummary context={context} active={tab.active} /> : null}
                  </TooltipTrigger>
                  <TooltipPopup side="bottom" className="max-w-56">
                    <span className="block text-left">
                      <span className="font-medium text-foreground">
                        {context?.label ?? "Independent"}
                      </span>
                      {context ? (
                        <span className="ml-1.5 text-muted-foreground">{context.detail}</span>
                      ) : null}
                    </span>
                  </TooltipPopup>
                </Tooltip>
                {tabs.length > 1 ? (
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
          {closedTabs.length > 0 ? (
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={
                        <button
                          type="button"
                          aria-label="Closed tabs"
                          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        />
                      }
                    />
                  }
                >
                  <HistoryIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  Closed tabs{reopenShortcut ? ` (${reopenShortcut})` : ""}
                </TooltipPopup>
              </Tooltip>
              <MenuPopup align="end" className="min-w-52 max-w-72">
                {closedTabs.map((tab, index) => {
                  const context = contextByTabKey.get(tab.key);
                  return (
                    <MenuItem
                      key={tab.key}
                      disabled={reopeningKey !== null}
                      onClick={() => reopen(tab)}
                    >
                      <RotateCcwIcon />
                      <span className="min-w-0 flex-1 truncate">{context?.title ?? tab.title}</span>
                      {context ? (
                        <span className="max-w-28 truncate text-xs text-muted-foreground">
                          {context.label}
                        </span>
                      ) : null}
                      {index === 0 && reopenShortcut ? (
                        <MenuShortcut>{reopenShortcut}</MenuShortcut>
                      ) : null}
                    </MenuItem>
                  );
                })}
              </MenuPopup>
            </Menu>
          ) : null}

          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label="New tab"
                        disabled={creatingMode !== null}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                      />
                    }
                  />
                }
              >
                <PlusIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                New tab{newTabShortcut ? ` (${newTabShortcut})` : ""}
              </TooltipPopup>
            </Tooltip>
            <MenuPopup align="end" className="min-w-48">
              <MenuItem disabled={creatingMode !== null} onClick={() => create("fresh")}>
                <PlusIcon />
                Empty
                {newTabShortcut ? <MenuShortcut>{newTabShortcut}</MenuShortcut> : null}
              </MenuItem>
              <MenuItem
                disabled={!canForkContext || creatingMode !== null}
                onClick={() => create("portable")}
              >
                <CopyPlusIcon />
                Copy current context
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </nav>
    </TooltipProvider>
  );
}
