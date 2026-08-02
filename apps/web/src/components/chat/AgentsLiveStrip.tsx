/**
 * One-line ambient agent awareness above the composer, rendered only while at
 * least one agent is pending/running/waiting. Awareness, not alarm: muted
 * treatment, the waiting count is the only amber emphasis, and clicking opens
 * the Agents panel. Static dot per the no-continuous-animation rule.
 */
import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import { Bot, ChevronDown } from "lucide-react";

export function AgentsLiveStrip({ model, onOpen }: { model: AgentPanelModel; onOpen: () => void }) {
  if (model.liveCount === 0) {
    return null;
  }

  const runningPhase = model.workflows
    .flatMap((group) => group.phases)
    .find((phase) => phase.state === "running");
  const totalAgents =
    model.runningCount + model.waitingCount + model.idleCount + model.settledCount;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/60 px-2.5 py-1.5 text-xs text-muted-foreground transition hover:bg-accent/50"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
      <Bot aria-hidden className="size-3.5 shrink-0" />
      <span>
        {totalAgents} agent{totalAgents === 1 ? "" : "s"}
      </span>
      {model.waitingCount > 0 ? (
        <span className="text-warning-foreground">{model.waitingCount} waiting</span>
      ) : null}
      {runningPhase ? (
        <span className="truncate text-muted-foreground/70">
          {runningPhase.title} · {runningPhase.activeCount} active
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1 font-mono tabular-nums text-muted-foreground/80">
        Σ {formatSubagentTokenCount(model.totalTokens)} tok
        <ChevronDown aria-hidden className="size-3" />
      </span>
    </button>
  );
}
