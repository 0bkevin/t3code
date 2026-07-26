import { assert, it } from "@effect/vitest";
import { OrchestrationMessageNotification } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionThreadMessageNotification", (it) => {
  it.effect("adds the notification column without disturbing existing messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });

      // An ordinary message written before the column existed. Proactive
      // deliveries are the exception, so every pre-existing row must survive
      // the migration with no notification rather than a synthesized default.
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        ) VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'an ordinary answer',
          0,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const rows = yield* sql<{
        readonly message_id: string;
        readonly text: string;
        readonly notification_json: string | null;
      }>`
        SELECT message_id, text, notification_json
        FROM projection_thread_messages
        WHERE message_id = 'message-1'
      `;

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "an ordinary answer");
      assert.equal(rows[0]?.notification_json, null);

      // And the new column accepts a delivery's provenance.
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at,
          notification_json
        ) VALUES (
          'message-2',
          'thread-1',
          NULL,
          'assistant',
          'Your digest is ready.',
          0,
          '2026-01-01T00:01:00.000Z',
          '2026-01-01T00:01:00.000Z',
          '{"kind":"cron","label":"Cron: daily-digest","deliveryId":"delivery-1"}'
        )
      `;

      const delivered = yield* sql<{
        readonly notification_json: string | null;
        readonly turn_id: string | null;
      }>`
        SELECT notification_json, turn_id
        FROM projection_thread_messages
        WHERE message_id = 'message-2'
      `;

      assert.equal(delivered.length, 1);
      // A delivery belongs to no turn — attributing it to the thread's live
      // turn would fold it away behind that turn's "Worked for …" row.
      assert.equal(delivered[0]?.turn_id, null);
      const decodedNotification = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(OrchestrationMessageNotification),
      )(delivered[0]?.notification_json ?? "");
      assert.deepEqual(decodedNotification, {
        kind: "cron",
        label: "Cron: daily-digest",
        deliveryId: "delivery-1",
      });
    }),
  );
});
