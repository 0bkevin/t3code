import type { OrchestrationMessageNotification } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveNotificationBadge } from "./notificationBadge.logic";

function makeNotification(
  overrides: Partial<OrchestrationMessageNotification> = {},
): OrchestrationMessageNotification {
  return {
    kind: "cron",
    label: "daily-digest",
    deliveryId: "delivery-1",
    ...overrides,
  } as OrchestrationMessageNotification;
}

describe("resolveNotificationBadge", () => {
  it("renders no badge for an ordinary assistant message", () => {
    // The overwhelmingly common case — a reply to a turn the user started.
    expect(resolveNotificationBadge(undefined)).toBe(null);
  });

  it("joins the kind and the label for a cron delivery", () => {
    expect(resolveNotificationBadge(makeNotification())).toEqual({
      label: "Cron · daily-digest",
      muted: false,
    });
  });

  it("labels an agent-initiated send as Agent, not Message", () => {
    expect(
      resolveNotificationBadge(makeNotification({ kind: "message", label: "check-in" })),
    ).toEqual({ label: "Agent · check-in", muted: false });
  });

  it("mutes lifecycle notices", () => {
    expect(
      resolveNotificationBadge(makeNotification({ kind: "lifecycle", label: "gateway online" })),
    ).toEqual({ label: "Gateway · gateway online", muted: true });
  });

  it("keeps handoff and other at normal weight", () => {
    expect(
      resolveNotificationBadge(makeNotification({ kind: "handoff", label: "to laptop" })),
    ).toEqual({ label: "Handoff · to laptop", muted: false });
    expect(resolveNotificationBadge(makeNotification({ kind: "other", label: "misc" }))).toEqual({
      label: "Notification · misc",
      muted: false,
    });
  });

  it("collapses to the kind alone when the label adds nothing", () => {
    // Agent-authored free text: it may be blank after trimming, or merely
    // repeat the kind. Either way a dangling separator would be noise.
    expect(resolveNotificationBadge(makeNotification({ label: "   " }))).toEqual({
      label: "Cron",
      muted: false,
    });
    expect(
      resolveNotificationBadge(makeNotification({ kind: "lifecycle", label: "gateway" })),
    ).toEqual({ label: "Gateway", muted: true });
  });
});
