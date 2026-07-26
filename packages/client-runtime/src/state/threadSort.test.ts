import { describe, expect, it } from "vite-plus/test";

import { sortThreads, type ThreadSortInput } from "./threadSort.ts";

type TestThread = { readonly id: string } & ThreadSortInput;

function makeThread(overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: "thread-1",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    messages: [],
    latestUserMessageAt: null,
    ...overrides,
  };
}

describe("sortThreads", () => {
  it("falls back to updatedAt and createdAt when latestUserMessageAt is invalid and there are no messages", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "not-a-date",
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: "thread-2",
          latestUserMessageAt: "still-not-a-date",
          createdAt: "invalid-created-at",
          updatedAt: "invalid-updated-at",
        }),
        makeThread({
          id: "thread-3",
          latestUserMessageAt: "invalid-latest-user-message-at",
          createdAt: "2026-03-09T10:06:00.000Z",
          updatedAt: "invalid-updated-at",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-3", "thread-1", "thread-2"]);
  });

  it("falls back to the latest valid user message when latestUserMessageAt is invalid", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "invalid-latest-user-message-at",
          updatedAt: "2026-03-09T10:00:00.000Z",
          messages: [
            { role: "user", createdAt: "2026-03-09T10:05:00.000Z" },
            { role: "assistant", createdAt: "2026-03-09T10:30:00.000Z" },
            { role: "user", createdAt: "2026-03-09T10:20:00.000Z" },
          ],
        }),
        makeThread({
          id: "thread-2",
          createdAt: "2026-03-09T10:15:00.000Z",
          updatedAt: "2026-03-09T10:15:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
  });

  it("pins the requested thread first regardless of its timestamp", () => {
    // The agent home thread: a designated destination, not a conversation the
    // user started, so staleness must not demote it.
    const sorted = sortThreads(
      [
        makeThread({ id: "thread-newest", updatedAt: "2026-03-09T12:00:00.000Z" }),
        makeThread({ id: "thread-home", updatedAt: "2026-01-01T00:00:00.000Z" }),
        makeThread({ id: "thread-middle", updatedAt: "2026-03-09T10:00:00.000Z" }),
      ],
      "updated_at",
      "thread-home",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      "thread-home",
      "thread-newest",
      "thread-middle",
    ]);
  });

  it("sorts unchanged when no thread is pinned or the pinned id is unknown", () => {
    const threads = [
      makeThread({ id: "thread-newest", updatedAt: "2026-03-09T12:00:00.000Z" }),
      makeThread({ id: "thread-oldest", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ];

    expect(sortThreads(threads, "updated_at").map((thread) => thread.id)).toEqual([
      "thread-newest",
      "thread-oldest",
    ]);
    expect(sortThreads(threads, "updated_at", null).map((thread) => thread.id)).toEqual([
      "thread-newest",
      "thread-oldest",
    ]);
    expect(sortThreads(threads, "updated_at", "thread-gone").map((thread) => thread.id)).toEqual([
      "thread-newest",
      "thread-oldest",
    ]);
  });
});
