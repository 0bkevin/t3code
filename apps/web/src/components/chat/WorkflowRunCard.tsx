/**
 * Inline workflow run card for the chat timeline: one card per coordinator,
 * replacing its generic task rows. Capped at eight member rows ordered by
 * urgency (failed and running first); overflow routes to the Agents panel.
 * The card is a derived, bounded view of the fold — the panel is the
 * complete one. Static status visuals only.
 */
import type { AgentPanelWorkflowGroup } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentTokenCount,
  workflowCardMembers,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { Bot, ExternalLink } from "lucide-react";

import { cn } from "~/lib/utils";

const INLINE_MEMBER_LIMIT = 8;

const MEMBER_DOT: Record<string, string> = {
  pending: "bg-muted-foreground/40",
  running: "bg-info",
  waiting: "bg-warning",
  idle: "bg-info/50",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/60",
  interrupted: "bg-muted-foreground/60",
};

function workflowStatusChip(group: AgentPanelWorkflowGroup): {
  label: string;
  className: string;
} {
  const status = group.workflow.status;
  if (status === "failed") {
    return { label: "Failed", className: "text-destructive-foreground border-destructive/40" };
  }
  if (status === "completed") {
    return { label: "Completed", className: "text-success-foreground border-success/40" };
  }
  if (status === "cancelled" || status === "interrupted") {
    return { label: "Stopped", className: "text-muted-foreground border-border" };
  }
  return { label: "Running", className: "text-info-foreground border-info/40" };
}

export function WorkflowRunCard({
  group,
  onOpenAgents,
}: {
  group: AgentPanelWorkflowGroup;
  onOpenAgents: () => void;
}) {
  const { visible, overflow } = workflowCardMembers(group, INLINE_MEMBER_LIMIT);
  const chip = workflowStatusChip(group);
  const allMembers = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  const settled = allMembers.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  const totalTokens = allMembers.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    group.workflow.usage?.totalTokens ?? 0,
  );
  const sessionUrl = group.workflow.runHandles?.sessionUrl;

  return (
    <div className="my-1.5 rounded-lg border border-border/70 bg-card/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Bot aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span
          className={cn("rounded-sm border px-1.5 py-0.5 font-mono text-[.65rem]", chip.className)}
        >
          {chip.label}
        </span>
        <span className="ml-auto font-mono text-[.7rem] tabular-nums text-muted-foreground">
          {settled}/{allMembers.length} agents · {formatSubagentTokenCount(totalTokens)} tok
        </span>
      </div>

      {sessionUrl ? (
        <a
          href={sessionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex items-center gap-1.5 text-xs text-info-foreground hover:underline"
        >
          <ExternalLink aria-hidden className="size-3" />
          Running in the cloud — open session
        </a>
      ) : (
        <div className="mt-2 space-y-0.5">
          {visible.map((member) => (
            <div key={member.id} className="flex items-baseline gap-2 text-xs">
              <span className="flex h-4 items-center">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    MEMBER_DOT[member.status] ?? "bg-muted-foreground/40",
                  )}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground/90">
                  {member.title}
                </span>
                {member.status === "failed" && member.error ? (
                  <span className="block truncate text-destructive-foreground">{member.error}</span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono text-[.7rem] tabular-nums text-muted-foreground/80">
                {member.phaseTitle ? `${member.phaseTitle} · ` : ""}
                {member.usage ? `${formatSubagentTokenCount(member.usage.totalTokens)} tok` : ""}
              </span>
            </div>
          ))}
          {overflow > 0 ? (
            <button
              type="button"
              onClick={onOpenAgents}
              className="pt-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              +{overflow} more agent{overflow === 1 ? "" : "s"} — open Agents
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
