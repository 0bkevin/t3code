/**
 * Pure headline/selector decision for the draft hero.
 *
 * Kept out of the component so the "which headline, and is the project picker
 * even meaningful here?" question is testable without rendering the project
 * menu and its whole sidebar-grouping dependency chain.
 */

/**
 * Which headline the draft hero renders, and whether the project picker
 * participates at all.
 *
 * - `build-in-project` — a project is resolved: "What should we build in
 *   {selector}?"
 * - `choose-project` — no project yet, but the user has projects to pick
 *   from: "{selector} to start"
 * - `add-project` — no project and nothing to pick: "Add a project to start"
 * - `agent` — the provider does not work in a workspace, so no directory
 *   question can be asked: "What's on your mind?" with no selector.
 */
export type DraftHeroHeadlineKind = "build-in-project" | "choose-project" | "add-project" | "agent";

export interface DraftHeroHeadlineDecision {
  readonly kind: DraftHeroHeadlineKind;
  /**
   * Whether the project picker/selector renders at all. False for `agent`,
   * where there is no directory to scope the thread to.
   */
  readonly showProjectSelector: boolean;
}

export const AGENT_DRAFT_HEADLINE = "What's on your mind?";

export function resolveDraftHeroHeadline(input: {
  /**
   * Absent-means-true capability flag, already resolved by the caller. When
   * false the thread targets a directoryless agent.
   */
  readonly requiresWorkspace: boolean;
  readonly hasResolvedProject: boolean;
  readonly canChooseProject: boolean;
}): DraftHeroHeadlineDecision {
  if (!input.requiresWorkspace) {
    return { kind: "agent", showProjectSelector: false };
  }
  if (input.hasResolvedProject) {
    return { kind: "build-in-project", showProjectSelector: true };
  }
  if (input.canChooseProject) {
    return { kind: "choose-project", showProjectSelector: true };
  }
  return { kind: "add-project", showProjectSelector: false };
}
