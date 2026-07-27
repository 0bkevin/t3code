import { describe, expect, it } from "@effect/vitest";

import {
  describeTaskTabContexts,
  taskTabDisplayTitle,
  type TaskTabContextSource,
} from "./taskTabContext";

function tab(
  overrides: Partial<TaskTabContextSource> & { threadId: string },
): TaskTabContextSource {
  return {
    kind: "server",
    title: overrides.threadId,
    position: 0,
    forkProvenance: null,
    ...overrides,
  };
}

describe("task tab context descriptors", () => {
  it("labels the first tab Main and gives it its own context", () => {
    const [main] = describeTaskTabContexts([tab({ threadId: "root", title: "Tab 1" })]);
    expect(main?.title).toBe("Main");
    expect(main?.kind).toBe("main");
    expect(main?.label).toBe("Independent");
    expect(main?.detail).toBe("Separate chat history.");
  });

  it("keeps an explicit tab label on the first tab", () => {
    expect(taskTabDisplayTitle(tab({ threadId: "root", title: "Reviewer" }))).toBe("Reviewer");
  });

  it("describes an unsent draft tab as starting empty", () => {
    const [, draft] = describeTaskTabContexts([
      tab({ threadId: "root", title: "Main" }),
      tab({
        threadId: "draft-thread",
        kind: "draft",
        title: "Tab 2",
        position: 1,
        forkProvenance: { mode: "fresh", sourceThreadId: null },
      }),
    ]);
    expect(draft?.kind).toBe("empty");
    expect(draft?.label).toBe("Empty");
    expect(draft?.detail).toBe("No chat history.");
  });

  it("describes a started sibling tab as independent, not shared", () => {
    const [, started] = describeTaskTabContexts([
      tab({ threadId: "root", title: "Main" }),
      tab({
        threadId: "second",
        title: "Tab 2",
        position: 1,
        forkProvenance: { mode: "fresh", sourceThreadId: null },
      }),
    ]);
    expect(started?.kind).toBe("own");
    expect(started?.label).toBe("Independent");
    expect(started?.detail).toBe("Separate chat history.");
  });

  it("resolves a portable fork's source to the sibling tab label", () => {
    const [, fork] = describeTaskTabContexts([
      tab({ threadId: "root", title: "Tab 1" }),
      tab({
        threadId: "fork",
        kind: "draft",
        title: "Tab 2",
        position: 1,
        forkProvenance: { mode: "portable", sourceThreadId: "root" },
      }),
    ]);
    expect(fork?.kind).toBe("snapshot");
    expect(fork?.sourceTitle).toBe("Main");
    expect(fork?.label).toBe("From Main");
    expect(fork?.detail).toBe("Copies Main once on send.");
  });

  it("describes a started fork in the past tense once it owns a thread", () => {
    const [, fork] = describeTaskTabContexts([
      tab({ threadId: "root", title: "Main" }),
      tab({
        threadId: "fork",
        title: "Retry",
        position: 1,
        forkProvenance: { mode: "portable", sourceThreadId: "root" },
      }),
    ]);
    expect(fork?.label).toBe("From Main");
    expect(fork?.detail).toBe("Started from Main; now independent.");
  });

  it("falls back to a neutral phrase when the source tab is gone", () => {
    const [fork] = describeTaskTabContexts([
      tab({
        threadId: "fork",
        title: "Retry",
        position: 1,
        forkProvenance: { mode: "portable", sourceThreadId: "closed-thread" },
      }),
    ]);
    expect(fork?.sourceTitle).toBeNull();
    expect(fork?.label).toBe("From other tab");
  });

  it("never invents message counts", () => {
    const descriptors = describeTaskTabContexts([
      tab({ threadId: "root", title: "Tab 1" }),
      tab({
        threadId: "fork",
        title: "Tab 2",
        position: 1,
        forkProvenance: { mode: "portable", sourceThreadId: "root" },
      }),
    ]);
    for (const descriptor of descriptors) {
      expect(`${descriptor.label} ${descriptor.detail}`).not.toMatch(/\d/);
    }
  });
});
