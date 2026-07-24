import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "workspace_task_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workspace_task_id TEXT
    `;
  }
  if (!columns.some((column) => column.name === "tab_label")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN tab_label TEXT
    `;
  }
  if (!columns.some((column) => column.name === "tab_position")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN tab_position INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!columns.some((column) => column.name === "tab_closed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN tab_closed_at TEXT
    `;
  }
  if (!columns.some((column) => column.name === "fork_provenance_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_provenance_json TEXT
    `;
  }

  // Every pre-task thread becomes a one-tab task. This makes the migration
  // lossless and lets mixed-version clients continue using thread routes.
  yield* sql`
    UPDATE projection_threads
    SET workspace_task_id = thread_id
    WHERE workspace_task_id IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_workspace_task
    ON projection_threads (workspace_task_id, tab_closed_at, tab_position, created_at, thread_id)
  `;
});
