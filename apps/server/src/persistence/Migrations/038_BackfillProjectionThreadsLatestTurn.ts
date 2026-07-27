import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Repairs `projection_threads.latest_turn_id` rows that were nulled at turn end.
 *
 * The `thread.session-set` projector wrote `session.activeTurnId` straight
 * through, so the session going back to `ready` (activeTurnId `null`) at the
 * end of a turn erased the pointer to the turn that had just finished. For
 * workspace providers that damage was invisible: `thread.turn-diff-completed`
 * fires moments later and re-writes the id. A provider with no workspace
 * (Hermes) emits no diff, so the id stayed null permanently — `latestTurn`
 * never resolved, and the settle guard read every completed turn as a
 * queued-but-unadopted turn start, refusing to settle the thread for the
 * length of the adoption grace window.
 *
 * The projector no longer nulls the field, but rows already written keep the
 * stale null: projections resume from their stored sequence rather than
 * replaying, so nothing re-derives them.
 *
 * Restores the newest turn per thread by `requested_at`, matching what the
 * projector would have retained. Deliberately conservative:
 *
 * - Only threads whose `latest_turn_id` is currently null are touched, so a
 *   correct pointer is never overwritten by this heuristic.
 * - Only threads that actually have a turn row are updated; the `WHERE
 *   EXISTS` keeps a thread that has never run a turn at null rather than
 *   inventing one.
 * - Ties on `requested_at` (possible when a turn is steered within the same
 *   millisecond) break on `row_id`, which is monotonic per insert.
 * - Rows with a null `turn_id` are skipped: those are pending turn-starts
 *   (requested but never adopted), and a dangling one is often the *newest*
 *   row on exactly the threads this bug stranded. Without the filter the
 *   subquery would select it and write NULL over NULL — silently skipping
 *   the repair of the completed turn underneath.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET latest_turn_id = (
      SELECT turns.turn_id
      FROM projection_turns turns
      WHERE turns.thread_id = projection_threads.thread_id
        AND turns.turn_id IS NOT NULL
      ORDER BY turns.requested_at DESC, turns.row_id DESC
      LIMIT 1
    )
    WHERE projection_threads.latest_turn_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns turns
        WHERE turns.thread_id = projection_threads.thread_id
          AND turns.turn_id IS NOT NULL
      )
  `;
});
