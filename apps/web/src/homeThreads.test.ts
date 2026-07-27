import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { homeThreadComposerPlaceholder, isHomeThreadId } from "./homeThreads";

const homeThreadId = ThreadId.make("thread-home");
const otherThreadId = ThreadId.make("thread-other");

const providers = [{ homeThreadId: undefined }, { homeThreadId }] as Parameters<
  typeof isHomeThreadId
>[0];

describe("isHomeThreadId", () => {
  it("recognizes the designated home thread", () => {
    expect(isHomeThreadId(providers, homeThreadId)).toBe(true);
  });

  it("does not claim an ordinary thread in the same project", () => {
    expect(isHomeThreadId(providers, otherThreadId)).toBe(false);
  });

  it("is false for a draft thread with no id yet", () => {
    // A draft must not inherit Home's fixed-binding composer treatment.
    expect(isHomeThreadId(providers, null)).toBe(false);
    expect(isHomeThreadId(providers, undefined)).toBe(false);
  });

  it("is false when no instance has designated one", () => {
    // Every non-Hermes driver, and a Hermes instance pre-handshake. An
    // `undefined` designation must never match an absent thread id.
    expect(isHomeThreadId([{ homeThreadId: undefined }], undefined)).toBe(false);
    expect(isHomeThreadId([], homeThreadId)).toBe(false);
  });
});

describe("homeThreadComposerPlaceholder", () => {
  it("addresses the agent by name", () => {
    expect(homeThreadComposerPlaceholder("Hermes Siva Local")).toBe("Message Hermes Siva Local");
  });

  it("falls back before the instance snapshot arrives", () => {
    expect(homeThreadComposerPlaceholder(undefined)).toBe("Message Hermes");
    expect(homeThreadComposerPlaceholder("   ")).toBe("Message Hermes");
  });
});
