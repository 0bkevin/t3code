import { describe, expect, it } from "vite-plus/test";

import { AGENT_DRAFT_HEADLINE, resolveDraftHeroHeadline } from "./DraftHeroHeadline.logic";

describe("resolveDraftHeroHeadline", () => {
  it("asks what to build when a project is resolved", () => {
    expect(
      resolveDraftHeroHeadline({
        requiresWorkspace: true,
        hasResolvedProject: true,
        canChooseProject: true,
      }),
    ).toEqual({ kind: "build-in-project", showProjectSelector: true });
  });

  it("still shows the selector for a resolved project with nothing else to pick", () => {
    expect(
      resolveDraftHeroHeadline({
        requiresWorkspace: true,
        hasResolvedProject: true,
        canChooseProject: false,
      }),
    ).toEqual({ kind: "build-in-project", showProjectSelector: true });
  });

  it("prompts for a project choice when one can be picked", () => {
    expect(
      resolveDraftHeroHeadline({
        requiresWorkspace: true,
        hasResolvedProject: false,
        canChooseProject: true,
      }),
    ).toEqual({ kind: "choose-project", showProjectSelector: true });
  });

  it("prompts to add a project when there is nothing to pick", () => {
    expect(
      resolveDraftHeroHeadline({
        requiresWorkspace: true,
        hasResolvedProject: false,
        canChooseProject: false,
      }),
    ).toEqual({ kind: "add-project", showProjectSelector: false });
  });

  it("drops the directory question entirely for a workspaceless provider", () => {
    for (const hasResolvedProject of [true, false]) {
      for (const canChooseProject of [true, false]) {
        expect(
          resolveDraftHeroHeadline({
            requiresWorkspace: false,
            hasResolvedProject,
            canChooseProject,
          }),
        ).toEqual({ kind: "agent", showProjectSelector: false });
      }
    }
  });

  it("pins the agent headline copy", () => {
    expect(AGENT_DRAFT_HEADLINE).toBe("What's on your mind?");
  });
});
