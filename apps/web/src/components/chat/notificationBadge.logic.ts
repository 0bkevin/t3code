import type { OrchestrationMessageNotification } from "@t3tools/contracts";

/**
 * Presentation for the small header badge above a proactive agent delivery.
 *
 * A notification is provenance, not content: the row underneath stays an
 * ordinary assistant message (selectable, copyable, part of the transcript)
 * and the badge only answers "who asked for this, since I didn't?".
 */
export interface NotificationBadgePresentation {
  /** Rendered text — "Cron · daily-digest", or just the kind when unlabelled. */
  readonly label: string;
  /**
   * `lifecycle` notices ("gateway online") are bookkeeping the user did not
   * ask for and will not act on, so they get the quieter treatment. Everything
   * else is content someone scheduled or sent and reads at normal weight.
   */
  readonly muted: boolean;
}

/**
 * Human name for a notification kind.
 *
 * `message` renders as "Agent" rather than "Message": every row in the
 * timeline is a message, so the useful distinction is that this one was the
 * agent's own initiative.
 */
const NOTIFICATION_KIND_LABELS: Record<OrchestrationMessageNotification["kind"], string> = {
  cron: "Cron",
  message: "Agent",
  lifecycle: "Gateway",
  handoff: "Handoff",
  other: "Notification",
};

/**
 * Badge for one message, or `null` when the message is an ordinary reply.
 *
 * "No notification" is the overwhelmingly common case and must never
 * synthesize a badge — an ordinary answer with a "Notification" chip on it
 * would be a lie about where it came from.
 *
 * The kind prefix is always shown even when a label repeats it, because the
 * label is agent-authored free text and cannot be trusted to carry the kind.
 * A label that is empty after trimming (or exactly the kind label) collapses
 * to the kind alone rather than rendering a dangling separator.
 */
export function resolveNotificationBadge(
  notification: OrchestrationMessageNotification | undefined,
): NotificationBadgePresentation | null {
  if (!notification) return null;
  const kindLabel = NOTIFICATION_KIND_LABELS[notification.kind] ?? NOTIFICATION_KIND_LABELS.other;
  const detail = notification.label.trim();
  const label =
    detail === "" || detail.toLowerCase() === kindLabel.toLowerCase()
      ? kindLabel
      : `${kindLabel} · ${detail}`;
  return { label, muted: notification.kind === "lifecycle" };
}
