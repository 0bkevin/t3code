/**
 * The projection read-model surface that seeding scripts write to.
 *
 * Must match `ORCHESTRATION_PROJECTOR_NAMES` in
 * apps/server/src/orchestration/Layers/ProjectionPipeline.ts — that package
 * exposes no importable surface, so this is a maintained copy. If a projector
 * is missing here, `computeSnapshotSequence` reports 0 and every shell
 * snapshot advertises sequence 0.
 */
export const PROJECTOR_NAMES = [
  "projection.projects",
  "projection.threads",
  "projection.thread-messages",
  "projection.thread-proposed-plans",
  "projection.thread-activities",
  "projection.thread-sessions",
  "projection.thread-turns",
  "projection.checkpoints",
  "projection.pending-approvals",
] as const;

/** Deleted in this order so a row never outlives what it points at. */
export const PROJECTION_TABLES_IN_DEPENDENCY_ORDER = [
  "projection_pending_approvals",
  "projection_thread_proposed_plans",
  "projection_thread_activities",
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_turns",
  "projection_threads",
  "projection_projects",
  "projection_state",
] as const;
