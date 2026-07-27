import type { PullRequestMonitorSnapshot } from "../sourceControl/gitHubPullRequestMonitor.ts";

export type PullRequestMonitorBlocker =
  | { readonly kind: "terminal"; readonly state: "closed" | "merged" }
  | { readonly kind: "draft" }
  | { readonly kind: "mergeability"; readonly state: "conflicting" | "unknown" }
  | { readonly kind: "checks-missing" }
  | { readonly kind: "check-pending"; readonly checkName: string }
  | { readonly kind: "check-failed"; readonly checkName: string }
  | { readonly kind: "changes-requested"; readonly reviewer: string }
  | { readonly kind: "unresolved-thread"; readonly threadId: string };

export interface PullRequestMonitorReadiness {
  readonly ready: boolean;
  readonly label: "ready-to-merge" | "no-known-blockers";
  readonly blockers: ReadonlyArray<PullRequestMonitorBlocker>;
}

export function computeReadiness(
  snapshot: PullRequestMonitorSnapshot,
  previousThreadVersions: Readonly<
    Record<string, { readonly updatedAt: string; readonly resolved: boolean }>
  > = {},
): PullRequestMonitorReadiness {
  const blockers: PullRequestMonitorBlocker[] = [];
  if (snapshot.state !== "open") blockers.push({ kind: "terminal", state: snapshot.state });
  if (snapshot.draft) blockers.push({ kind: "draft" });
  if (snapshot.mergeability !== "mergeable") {
    blockers.push({ kind: "mergeability", state: snapshot.mergeability });
  }
  const currentChecks = snapshot.checkRuns.filter((check) => check.headSha === snapshot.headSha);
  if (currentChecks.length === 0) blockers.push({ kind: "checks-missing" });
  for (const check of currentChecks) {
    if (check.status !== "completed") {
      blockers.push({ kind: "check-pending", checkName: check.name });
    } else if (
      check.conclusion !== "success" &&
      check.conclusion !== "neutral" &&
      check.conclusion !== "skipped"
    ) {
      blockers.push({ kind: "check-failed", checkName: check.name });
    }
  }
  const latestOpinionatedReviews = new Map<string, (typeof snapshot.reviews)[number]>();
  for (const review of snapshot.reviews) {
    if (review.state !== "changes-requested" && review.state !== "approved") continue;
    const previous = latestOpinionatedReviews.get(review.author.login);
    if (previous === undefined || (review.submittedAt ?? "") > (previous.submittedAt ?? "")) {
      latestOpinionatedReviews.set(review.author.login, review);
    }
  }
  for (const review of latestOpinionatedReviews.values()) {
    // Stale approvals must not count toward green, but a changes-requested
    // review blocks regardless of which commit it reviewed — GitHub keeps it
    // active until dismissed or superseded by a re-review.
    if (review.state === "changes-requested") {
      blockers.push({ kind: "changes-requested", reviewer: review.author.login });
    }
  }
  for (const thread of snapshot.reviewThreads) {
    const previous = previousThreadVersions[thread.id];
    const changedSinceStart =
      snapshot.monitoringStartedAt === undefined ||
      thread.updatedAt > snapshot.monitoringStartedAt ||
      (previous?.resolved === true && !thread.resolved);
    if (!thread.resolved && changedSinceStart) {
      blockers.push({ kind: "unresolved-thread", threadId: thread.id });
    }
  }

  const evidenceSupportsReadyLabel = snapshot.requiredChecksKnown && currentChecks.length > 0;
  return {
    ready: blockers.length === 0,
    label: evidenceSupportsReadyLabel ? "ready-to-merge" : "no-known-blockers",
    blockers,
  };
}
