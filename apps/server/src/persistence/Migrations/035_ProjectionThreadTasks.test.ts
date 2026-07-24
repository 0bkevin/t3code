import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ProjectionThreadTasks", (it) => {
  it.effect("backfills legacy threads as one-tab tasks and creates the lookup index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });
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
          archived_at,
          settled_override,
          settled_at,
          snoozed_until,
          snoozed_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-legacy',
          'project-1',
          'Legacy thread',
          '{"instanceId":"codex","model":"gpt-5"}',
          'full-access',
          'default',
          'main',
          '/tmp/worktree',
          NULL,
          '2026-07-24T00:00:00.000Z',
          '2026-07-24T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const rows = yield* sql<{
        readonly workspaceTaskId: string;
        readonly tabPosition: number;
        readonly tabClosedAt: string | null;
        readonly forkProvenance: string | null;
      }>`
        SELECT
          workspace_task_id AS "workspaceTaskId",
          tab_position AS "tabPosition",
          tab_closed_at AS "tabClosedAt",
          fork_provenance_json AS "forkProvenance"
        FROM projection_threads
        WHERE thread_id = 'thread-legacy'
      `;
      assert.deepStrictEqual(rows, [
        {
          workspaceTaskId: "thread-legacy",
          tabPosition: 0,
          tabClosedAt: null,
          forkProvenance: null,
        },
      ]);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_projection_threads_workspace_task"));
    }),
  );
});
