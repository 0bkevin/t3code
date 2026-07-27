import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration037 from "./037_ProjectionThreadsLatestNotification.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_ProjectionThreadsLatestNotification", (it) => {
  it.effect("adds a nullable latest_notification_json column, leaving existing rows null", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(!before.some((column) => column.name === "latest_notification_json"));

      yield* sql`
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
          'thread-pre-037',
          'project-pre-037',
          'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 37 });

      const after = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_threads)
      `;
      const column = after.find((entry) => entry.name === "latest_notification_json");
      assert.ok(column);
      assert.strictEqual(column.type, "TEXT");
      assert.strictEqual(column.notnull, 0);
      assert.strictEqual(column.dflt_value, null);

      // No backfill is needed or possible: notification_json (migration 036)
      // is newer than every pre-existing row, so nothing to summarize.
      const rows = yield* sql<{ readonly latestNotification: string | null }>`
        SELECT latest_notification_json AS "latestNotification"
        FROM projection_threads
        WHERE thread_id = 'thread-pre-037'
      `;
      assert.deepStrictEqual(rows, [{ latestNotification: null }]);
    }),
  );

  it.effect("is idempotent: re-running against a migrated database is a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // The layer shares one in-memory database across this file's tests, so
      // the schema may already be at 37 here; make sure it is, then apply the
      // migration effect again directly — the migrator's tracking table would
      // otherwise skip it, which is exactly the protection a restored backup
      // or divergent branch does not have.
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* Migration037;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(
        columns.filter((column) => column.name === "latest_notification_json").length,
        1,
      );
    }),
  );
});
