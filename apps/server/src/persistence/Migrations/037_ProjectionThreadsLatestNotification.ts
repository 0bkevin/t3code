import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Materializes the thread's newest proactive delivery onto the shell row.
 *
 * Shell consumers (sidebar, agent-awareness/push) never read a thread's
 * messages, so notification provenance that lives on the message row is
 * invisible to them unless it is summarized here — the same reason
 * `latest_user_message_at` exists.
 *
 * No backfill: `projection_thread_messages.notification_json` is introduced by
 * migration 036, so no delivery predates this column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN latest_notification_json TEXT
  `;
});
