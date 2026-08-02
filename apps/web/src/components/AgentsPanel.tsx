/**
 * Agents right-panel surface: the fleet view over the native subagent fold,
 * and the ONLY place the roster renders (the chat carries one CTA row per
 * spawn batch).
 *
 * Visualization rules (from live-test feedback):
 * - Live work first: running workflows and direct spawns sort above settled.
 * - Rows are flat status lines — no expansion, no per-agent tool feeds. The
 *   row answers "who / what phase / how much"; anything deeper is a future
 *   drill-in, not an unfold.
 * - A settled workflow run collapses to a single summary line; click it to
 *   show its member list inline (the one allowed toggle — run granularity,
 *   not agent granularity).
 * - Static status dots, DOM-write elapsed timers, plain token counters.
 */
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import { Bot, Check, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";

/**
 * In-flight states all present as Working (one steady state, per the
 * monitoring-pill design: detail belongs in the activity sub-line, and a
 * stalled/waiting/queued subagent is still the fleet doing its job, not a
 * user problem). Only settled states differentiate.
 */
const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
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
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
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

/** Flat, non-interactive agent status line. No unfold. */
function AgentRow({ agent }: { agent: RuntimeSubagent }) {
  const visuals = STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);

  return (
    <div className="rounded-md px-1.5 py-1">
      <div className="flex items-start gap-2">
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
                agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
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
            <span className="sr-only">{visuals.label}</span>
          </span>
        </span>
      </div>
    </div>
  );
}

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  );
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
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
            ? `${phase.settledCount} done`
            : `${phase.activeCount} active · ${phase.settledCount} done`}
      </span>
    </div>
  );
}

/** Live workflow: full phase tree. */
function LiveWorkflowSection({ group }: { group: AgentPanelWorkflowGroup }) {
  const members = workflowMembers(group);
  const settled = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  return (
    <section className="rounded-lg border border-border/50 bg-card/30 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-info" />
        <span>{group.workflow.workflowName ?? group.workflow.title}</span>
        <span className="ml-auto font-mono normal-case text-muted-foreground/80">
          {settled}/{members.length} settled
        </span>
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

/**
 * Settled workflow: one summary line. Click toggles the member list — the
 * only expansion in the panel, at run granularity.
 */
function SettledWorkflowSection({ group }: { group: AgentPanelWorkflowGroup }) {
  const [open, setOpen] = useState(false);
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    group.workflow.usage?.totalTokens ?? 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
        aria-expanded={open}
      >
        <StatusDot status={failed > 0 ? "failed" : group.workflow.status} />
        <span className="truncate text-sm">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/80">
          {failed > 0 ? <span className="text-destructive-foreground">{failed} failed</span> : null}
          <span>{members.length} agents</span>
          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          {open ? (
            <ChevronDown aria-hidden className="size-3" />
          ) : (
            <ChevronRight aria-hidden className="size-3" />
          )}
        </span>
      </button>
      {open ? (
        <div className="ms-3 border-s border-border/45 ps-2">
          {members.map((member) => (
            <AgentRow key={member.id} agent={member} />
          ))}
        </div>
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

  const liveWorkflows = model.workflows.filter(workflowIsLive);
  const settledWorkflows = model.workflows.filter((group) => !workflowIsLive(group));
  const liveDirect = model.directAgents.filter(
    (agent) =>
      agent.status === "running" ||
      agent.status === "pending" ||
      agent.status === "waiting" ||
      agent.status === "idle",
  );
  const settledDirect = model.directAgents.filter(
    (agent) =>
      agent.status !== "running" &&
      agent.status !== "pending" &&
      agent.status !== "waiting" &&
      agent.status !== "idle",
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          {liveWorkflows.map((group) => (
            <LiveWorkflowSection key={group.workflow.id} group={group} />
          ))}
          {liveDirect.length > 0 ? (
            <section>
              <div className="px-1.5 pt-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
                Direct spawns
              </div>
              {liveDirect.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </section>
          ) : null}
          {settledWorkflows.length > 0 || settledDirect.length > 0 ? (
            <section>
              <div className="px-1.5 pt-2 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground/70">
                Earlier
              </div>
              {settledWorkflows.map((group) => (
                <SettledWorkflowSection key={group.workflow.id} group={group} />
              ))}
              {settledDirect.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </section>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
        <span className="flex items-center gap-2">
          {model.runningCount + model.waitingCount > 0 ? (
            <span className="text-info-foreground">
              ● {model.runningCount + model.waitingCount} working
            </span>
          ) : null}
          {model.idleCount > 0 ? <span>{model.idleCount} idle</span> : null}
          {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}
        </span>
        <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
      </footer>
    </div>
  );
}
