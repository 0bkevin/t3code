import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertThread = (sql: SqlClient.SqlClient, threadId: string, latestTurnId: string | null) =>
  sql`
    INSERT INTO projection_threads (
      thread_id,
      project_id,
      title,
      model_selection_json,
      runtime_mode,
      interaction_mode,
      branch,
      worktree_path,
      latest_turn_id,
      created_at,
      updated_at,
      deleted_at
    )
    VALUES (
      ${threadId},
      'project-038',
      'Thread',
      '{"instanceId":"hermes-local","model":"hermes"}',
      'full-access',
      'default',
      NULL,
      NULL,
      ${latestTurnId},
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      NULL
    )
  `;

const insertTurn = (
  sql: SqlClient.SqlClient,
  threadId: string,
  turnId: string,
  requestedAt: string,
) =>
  sql`
    INSERT INTO projection_turns (
      thread_id,
      turn_id,
      pending_message_id,
      assistant_message_id,
      state,
      requested_at,
      started_at,
      completed_at,
      checkpoint_files_json
    )
    VALUES (
      ${threadId},
      ${turnId},
      NULL,
      NULL,
      'completed',
      ${requestedAt},
      ${requestedAt},
      ${requestedAt},
      '[]'
    )
  `;

const insertPendingTurnStart = (sql: SqlClient.SqlClient, threadId: string, requestedAt: string) =>
  sql`
    INSERT INTO projection_turns (
      thread_id,
      turn_id,
      pending_message_id,
      assistant_message_id,
      state,
      requested_at,
      started_at,
      completed_at,
      checkpoint_files_json
    )
    VALUES (
      ${threadId},
      NULL,
      'pending-message-038',
      NULL,
      'pending',
      ${requestedAt},
      NULL,
      NULL,
      '[]'
    )
  `;

const readLatestTurnId = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ readonly latestTurnId: string | null }>`
    SELECT latest_turn_id AS "latestTurnId"
    FROM projection_threads
    WHERE thread_id = ${threadId}
  `;

layer("038_BackfillProjectionThreadsLatestTurn", (it) => {
  // A single test on purpose: `it.layer` shares one in-memory database across
  // the block, so a second `it.effect` would find the migration already run
  // and assert against a no-op. All fixtures are written between migration 37
  // and 38 so every scenario exercises the actual backfill.
  it.effect("backfills nulled pointers without touching set or turnless ones", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      // Pointer nulled at turn end (the Hermes case): restore the newest turn.
      yield* insertThread(sql, "thread-hermes", null);
      yield* insertTurn(sql, "thread-hermes", "hermes-turn-old", "2026-07-01T00:00:00.000Z");
      yield* insertTurn(sql, "thread-hermes", "hermes-turn-new", "2026-07-01T00:05:00.000Z");

      // A correct pointer must survive: the backfill is a heuristic, and the
      // projector's own value is authoritative wherever it exists.
      yield* insertThread(sql, "thread-codex", "turn-kept");
      yield* insertTurn(sql, "thread-codex", "turn-kept", "2026-07-01T00:00:00.000Z");
      yield* insertTurn(sql, "thread-codex", "turn-newer", "2026-07-01T00:09:00.000Z");

      // A requested-but-never-adopted turn leaves a `turn_id IS NULL` row,
      // and on the stranded threads this migration targets it is often the
      // NEWEST row. Selecting it would write NULL over NULL — silently
      // skipping the repair of the completed turn underneath.
      yield* insertThread(sql, "thread-dangling", null);
      yield* insertTurn(sql, "thread-dangling", "turn-completed", "2026-07-01T00:00:00.000Z");
      yield* insertPendingTurnStart(sql, "thread-dangling", "2026-07-01T00:05:00.000Z");

      // Inventing a turn for a thread that never ran one would make a fresh
      // thread look like it had already run one.
      yield* insertThread(sql, "thread-empty", null);

      // A thread whose ONLY row is a dangling pending start has no turn to
      // restore — it must stay null rather than "repair" to null noisily.
      yield* insertThread(sql, "thread-pending-only", null);
      yield* insertPendingTurnStart(sql, "thread-pending-only", "2026-07-01T00:05:00.000Z");

      yield* runMigrations({ toMigrationInclusive: 38 });

      assert.deepStrictEqual(yield* readLatestTurnId(sql, "thread-hermes"), [
        { latestTurnId: "hermes-turn-new" },
      ]);
      assert.deepStrictEqual(yield* readLatestTurnId(sql, "thread-codex"), [
        { latestTurnId: "turn-kept" },
      ]);
      assert.deepStrictEqual(yield* readLatestTurnId(sql, "thread-dangling"), [
        { latestTurnId: "turn-completed" },
      ]);
      assert.deepStrictEqual(yield* readLatestTurnId(sql, "thread-empty"), [
        { latestTurnId: null },
      ]);
      assert.deepStrictEqual(yield* readLatestTurnId(sql, "thread-pending-only"), [
        { latestTurnId: null },
      ]);
    }),
  );
});
