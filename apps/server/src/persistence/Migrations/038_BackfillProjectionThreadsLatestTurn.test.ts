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

const readLatestTurnId = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ readonly latestTurnId: string | null }>`
    SELECT latest_turn_id AS "latestTurnId"
    FROM projection_threads
    WHERE thread_id = ${threadId}
  `;

layer("038_BackfillProjectionThreadsLatestTurn", (it) => {
  it.effect("restores the newest turn on a thread whose pointer was nulled at turn end", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* insertThread(sql, "thread-hermes", null);
      yield* insertTurn(sql, "thread-hermes", "hermes-turn-old", "2026-07-01T00:00:00.000Z");
      yield* insertTurn(sql, "thread-hermes", "hermes-turn-new", "2026-07-01T00:05:00.000Z");

      yield* runMigrations({ toMigrationInclusive: 38 });

      assert.deepStrictEqual(yield* readLatestTurnId(sql, "thread-hermes"), [
        { latestTurnId: "hermes-turn-new" },
      ]);
    }),
  );

  it.effect("never overwrites a pointer that is already set", () =>
    Effect.gen(function* () {
      // A correct pointer must survive: the backfill is a heuristic, and the
      // projector's own value is authoritative wherever it exists.
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* insertThread(sql, "thread-codex", "turn-kept");
      yield* insertTurn(sql, "thread-codex", "turn-kept", "2026-07-01T00:00:00.000Z");
      yield* insertTurn(sql, "thread-codex", "turn-newer", "2026-07-01T00:09:00.000Z");

      yield* runMigrations({ toMigrationInclusive: 38 });

      assert.deepStrictEqual(yield* readLatestTurnId(sql, "thread-codex"), [
        { latestTurnId: "turn-kept" },
      ]);
    }),
  );

  it.effect("leaves a thread that has never run a turn at null", () =>
    Effect.gen(function* () {
      // Inventing a turn here would make a fresh thread look like it had
      // already run one.
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* insertThread(sql, "thread-empty", null);

      yield* runMigrations({ toMigrationInclusive: 38 });

      assert.deepStrictEqual(yield* readLatestTurnId(sql, "thread-empty"), [
        { latestTurnId: null },
      ]);
    }),
  );
});
