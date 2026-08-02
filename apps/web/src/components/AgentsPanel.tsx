/**
 * Agents right-panel surface: the fleet view over the native subagent fold.
 *
 * Grouping: one section per workflow (phase headers with active/settled
 * counts), then a Direct spawns section. Rows expand in place to the
 * recent-activity ring. All status dots are static (no continuous
 * animation); elapsed time uses the WorkingTimer DOM-write pattern.
 */
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import { Bot, ChevronDown, ChevronRight, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";

const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-muted-foreground/40", label: "Queued" },
  running: { dotClass: "bg-info", label: "Running" },
  waiting: { dotClass: "bg-warning", label: "Waiting" },
  idle: { dotClass: "bg-info/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/**
 * Status-dependent activity line. Live cards lead with what is happening now;
 * settled cards lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  const live = agent.status === "running" || agent.status === "pending";
  if (agent.status === "waiting") {
    return "Waiting on approval or input";
  }
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

function AgentRow({ agent }: { agent: RuntimeSubagent }) {
  const [expanded, setExpanded] = useState(false);
  const visuals = STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  const hasFeed = agent.recentActivity.length > 0;

  return (
    <div className="rounded-md px-1.5 py-1 hover:bg-accent/40">
      <button
        type="button"
        className={cn("flex w-full items-start gap-2 text-left", !hasFeed && "cursor-default")}
        onClick={() => hasFeed && setExpanded((value) => !value)}
        aria-expanded={hasFeed ? expanded : undefined}
      >
        <span className="flex h-5 items-center">
          <StatusDot status={agent.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-medium">{agent.title}</span>
            {agent.role ? (
              <span className="max-w-28 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
                {agent.role}
              </span>
            ) : null}
            {agent.model ? (
              <span className="max-w-28 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
                {agent.model}
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-1 font-mono text-[.7rem] text-muted-foreground/80">
              <AgentElapsed agent={agent} />
              {agent.status === "completed" ? (
                <Check aria-hidden className="size-3 text-success" />
              ) : null}
            </span>
          </span>
          {activity ? (
            <span
              className={cn(
                "mt-0.5 block truncate text-xs",
                agent.status === "failed"
                  ? "text-destructive-foreground"
                  : agent.status === "waiting"
                    ? "text-warning-foreground"
                    : "text-muted-foreground",
              )}
            >
              {activity}
            </span>
          ) : null}
          <span className="mt-0.5 flex items-center gap-1 font-mono text-[.7rem] text-muted-foreground/70">
            {agent.usage ? (
              <span className="tabular-nums">
                {formatSubagentTokenCount(agent.usage.totalTokens)} tok
              </span>
            ) : null}
            {agent.usage?.toolUses !== undefined ? (
              <span>· {agent.usage.toolUses} tools</span>
            ) : null}
            {agent.activationCount > 1 ? <span>· run {agent.activationCount}</span> : null}
            {hasFeed ? (
              expanded ? (
                <ChevronDown aria-hidden className="size-3" />
              ) : (
                <ChevronRight aria-hidden className="size-3" />
              )
            ) : null}
            <span className="sr-only">{visuals.label}</span>
          </span>
        </span>
      </button>
      {expanded && hasFeed ? (
        <div className="ms-3.5 mt-1 border-s border-border/45 ps-3">
          {agent.recentActivity.toReversed().map((entry) => (
            <div
              key={`${entry.at}:${entry.summary}`}
              className="flex gap-2 py-0.5 text-xs text-muted-foreground"
            >
              <span className="shrink-0 font-mono tabular-nums text-muted-foreground/60">
                {entry.at.slice(11, 19)}
              </span>
              <span className="min-w-0 break-words">{entry.summary}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PhaseHeader({ phase }: { phase: AgentPanelWorkflowGroup["phases"][number] }) {
  return (
    <div
      className={cn(
        "mt-2 flex items-center gap-1.5 px-1.5 text-[.65rem] font-medium uppercase tracking-wider",
        phase.state === "done"
          ? "text-success-foreground"
          : phase.state === "running"
            ? "text-info-foreground"
            : "text-muted-foreground/70",
      )}
    >
      {phase.state === "done" ? <Check aria-hidden className="size-3" /> : null}
      <span>{phase.title}</span>
      <span className="font-normal normal-case text-muted-foreground/70">
        {phase.state === "pending" && phase.members.length === 0
          ? "pending"
          : phase.state === "done"
            ? ""
            : `${phase.activeCount} active · ${phase.settledCount} done`}
      </span>
    </div>
  );
}

function WorkflowGroupSection({ group }: { group: AgentPanelWorkflowGroup }) {
  return (
    <section>
      <div className="flex items-center gap-2 px-1.5 pt-2 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <span>Workflow · {group.workflow.workflowName ?? group.workflow.title}</span>
        {group.workflow.runHandles?.scriptPath ? (
          <span className="rounded-sm border border-border/60 px-1 font-mono normal-case">
            {"{}"} script
          </span>
        ) : null}
      </div>
      {group.phases.map((phase) => (
        <div key={phase.index}>
          <PhaseHeader phase={phase} />
          {phase.members.map((member) => (
            <AgentRow key={member.id} agent={member} />
          ))}
        </div>
      ))}
      {group.unphasedMembers.map((member) => (
        <AgentRow key={member.id} agent={member} />
      ))}
      {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
        <AgentRow agent={group.workflow} />
      ) : null}
    </section>
  );
}

export function AgentsPanel({ model }: { model: AgentPanelModel }) {
  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents or runs a workflow, they show up here with live status,
          activity, and token usage.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 p-2">
          {model.workflows.map((group) => (
            <WorkflowGroupSection key={group.workflow.id} group={group} />
          ))}
          {model.directAgents.length > 0 ? (
            <section>
              <div className="px-1.5 pt-2 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
                Direct spawns
              </div>
              {model.directAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </section>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
        <span className="flex items-center gap-2">
          {model.runningCount > 0 ? (
            <span className="text-info-foreground">● {model.runningCount} running</span>
          ) : null}
          {model.waitingCount > 0 ? (
            <span className="text-warning-foreground">{model.waitingCount} waiting</span>
          ) : null}
          {model.idleCount > 0 ? <span>{model.idleCount} idle</span> : null}
          {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}
        </span>
        <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
      </footer>
    </div>
  );
}
