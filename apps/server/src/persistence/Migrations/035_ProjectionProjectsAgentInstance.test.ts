import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ProjectionProjectsAgentInstance", (it) => {
  it.effect("adds a nullable agent_instance_id column and its index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.ok(!before.some((column) => column.name === "agent_instance_id"));

      yield* runMigrations({ toMigrationInclusive: 35 });

      const after = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_projects)
      `;
      const agentInstanceColumn = after.find((column) => column.name === "agent_instance_id");
      assert.ok(agentInstanceColumn);
      assert.strictEqual(agentInstanceColumn.type, "TEXT");
      assert.strictEqual(agentInstanceColumn.notnull, 0);
      assert.strictEqual(agentInstanceColumn.dflt_value, null);

      const indexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_projects)
      `;
      assert.ok(
        indexes.some((index) => index.name === "idx_projection_projects_agent_instance_id"),
      );

      const indexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_projects_agent_instance_id')
      `;
      assert.deepStrictEqual(
        indexColumns.map((column) => column.name),
        ["agent_instance_id"],
      );
    }),
  );
});
