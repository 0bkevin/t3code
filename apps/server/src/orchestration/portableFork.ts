import type { OrchestrationMessage, OrchestrationThread } from "@t3tools/contracts";

const MAX_HANDOFF_CHARACTERS = 48_000;

function renderMessage(message: OrchestrationMessage): string {
  const attachmentNote =
    message.attachments && message.attachments.length > 0
      ? `\n[${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"} omitted from the handoff]`
      : "";
  return `<message role="${message.role}">\n${message.text}${attachmentNote}\n</message>`;
}

/**
 * Builds a provider-neutral first-turn handoff for a context-forked task tab.
 * The source transcript remains owned by its original thread; the child only
 * receives this bounded snapshot as provider input.
 */
export function buildPortableForkProviderInput(input: {
  readonly source: OrchestrationThread;
  readonly userInput: string;
}): string {
  const header = [
    "<t3-task-tab-context>",
    "You are continuing in a sibling tab of the same T3 Code task.",
    "The sibling tabs share one worktree. Treat the source transcript below as prior context,",
    "but follow the new user request after the closing tag as the current instruction.",
    `Source tab: ${input.source.title}`,
    `Source thread id: ${input.source.id}`,
    `Source branch: ${input.source.branch ?? "(current checkout)"}`,
    `Shared worktree: ${input.source.worktreePath ?? "(project workspace)"}`,
    "<source-transcript>",
  ].join("\n");
  const footer = "\n</source-transcript>\n</t3-task-tab-context>";
  const fixedSize = header.length + footer.length;
  const budget = Math.max(0, MAX_HANDOFF_CHARACTERS - fixedSize);
  const selected: string[] = [];
  let used = 0;

  // Preserve the most recent context when the source conversation is larger
  // than the portable handoff budget.
  for (let index = input.source.messages.length - 1; index >= 0; index -= 1) {
    const message = input.source.messages[index];
    if (!message) continue;
    const rendered = renderMessage(message);
    if (used + rendered.length > budget) {
      continue;
    }
    selected.unshift(rendered);
    used += rendered.length;
  }

  const transcript =
    selected.length > 0 ? selected.join("\n") : "[No source transcript was available.]";
  return `${header}\n${transcript}${footer}\n\n${input.userInput}`;
}
