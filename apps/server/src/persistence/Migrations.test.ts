import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationIdentityMismatchError, validateMigrationIdentities } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("migration identity validation", (it) => {
  const createTrackingTable = Effect.fn("test.createMigrationTrackingTable")(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE IF NOT EXISTS effect_sql_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        name varchar(255) NOT NULL,
        created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;
    yield* sql`DELETE FROM effect_sql_migrations`;
  });

  it.effect("rejects a reused migration ID before migrations run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createTrackingTable();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (35, 'DifferentMigration')
      `;

      const error = yield* validateMigrationIdentities().pipe(Effect.flip);
      assert.instanceOf(error, MigrationIdentityMismatchError);
      assert.equal(error.migrationId, 35);
      assert.equal(error.expectedName, "ProjectionThreadTitleRegeneration");
      assert.equal(error.actualName, "DifferentMigration");
    }),
  );

  it.effect("allows migration IDs this build does not know about", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createTrackingTable();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (999, 'FutureMigration')
      `;

      yield* validateMigrationIdentities();
    }),
  );
});
