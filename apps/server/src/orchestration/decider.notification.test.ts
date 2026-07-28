import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-01T00:00:00.000Z";
const DELIVERED_AT = "2026-06-30T09:00:00.000Z";
const SETTLED_AT = "2026-06-29T00:00:00.000Z";
const SNOOZED_UNTIL = "2026-07-02T00:00:00.000Z";

function makeReadModel(input: {
  readonly settledOverride?: OrchestrationThread["settledOverride"];
  readonly snoozedUntil?: string | null;
  readonly messages?: OrchestrationThread["messages"];
}): OrchestrationReadModel {
  const settledOverride = input.settledOverride ?? null;
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Home",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride,
        settledAt: settledOverride === "settled" ? SETTLED_AT : null,
        snoozedUntil: input.snoozedUntil ?? null,
        snoozedAt: input.snoozedUntil != null ? SETTLED_AT : null,
        deletedAt: null,
        messages: input.messages ?? [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

function deliverCommand(overrides: {
  readonly commandId: string;
  readonly kind?: "cron" | "message" | "lifecycle" | "handoff" | "other";
  readonly deliveryId?: string;
  readonly messageId?: string;
  readonly text?: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly turnId?: TurnId;
}) {
  return {
    type: "thread.notification.deliver",
    commandId: CommandId.make(overrides.commandId),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(overrides.messageId ?? "message-1"),
    deliveryId: overrides.deliveryId ?? "delivery-1",
    kind: overrides.kind ?? "cron",
    label: "Cron: daily-digest",
    text: overrides.text ?? "Digest ready.",
    ...(overrides.attachments !== undefined ? { attachments: overrides.attachments } : {}),
    ...(overrides.turnId !== undefined ? { turnId: overrides.turnId } : {}),
    createdAt: NOW,
  } as const;
}

const mediaAttachment: ChatAttachment = {
  type: "file",
  id: "thread-1-2c8b3f1e-0000-4000-8000-000000000001",
  name: "chart.mp4",
  mimeType: "video/mp4",
  sizeBytes: 2_048,
};

const deliveredMessage: OrchestrationThread["messages"][number] = {
  id: MessageId.make("message-1"),
  role: "assistant",
  text: "Digest ready.",
  turnId: null,
  streaming: false,
  notification: {
    kind: "cron",
    label: "Cron: daily-digest",
    deliveryId: "delivery-1",
  },
  createdAt: DELIVERED_AT,
  updatedAt: DELIVERED_AT,
};

it.layer(NodeServices.layer)("notification delivery decider", (it) => {
  it.effect("appends a turnless notification message and un-settles the thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: deliverCommand({ commandId: "cmd-deliver" }),
        readModel: makeReadModel({ settledOverride: "settled" }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.notification-delivered",
      ]);

      const unsettled = events[0];
      if (unsettled?.type === "thread.unsettled") {
        expect(unsettled.payload.reason).toBe("activity");
      }

      const delivered = events[1];
      if (delivered?.type === "thread.notification-delivered") {
        expect(delivered.payload.messageId).toBe("message-1");
        expect(delivered.payload.text).toBe("Digest ready.");
        expect(delivered.payload.notification).toEqual({
          kind: "cron",
          label: "Cron: daily-digest",
          deliveryId: "delivery-1",
        });
        // Nothing about a delivery belongs to a turn; attributing it to the
        // thread's live turn would fold it behind that turn's summary.
        expect("turnId" in delivered.payload).toBe(false);
      }
    }),
  );

  it.effect("un-snoozes as well as un-settles, and does neither when neither applies", () =>
    Effect.gen(function* () {
      const both = yield* decideOrchestrationCommand({
        command: deliverCommand({ commandId: "cmd-deliver-both" }),
        readModel: makeReadModel({ settledOverride: "settled", snoozedUntil: SNOOZED_UNTIL }),
      });
      expect((Array.isArray(both) ? both : [both]).map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.unsnoozed",
        "thread.notification-delivered",
      ]);

      const neither = yield* decideOrchestrationCommand({
        command: deliverCommand({ commandId: "cmd-deliver-neither" }),
        readModel: makeReadModel({}),
      });
      expect((Array.isArray(neither) ? neither : [neither]).map((event) => event.type)).toEqual([
        "thread.notification-delivered",
      ]);
    }),
  );

  it.effect("appends lifecycle notices quietly, leaving settled and snoozed state alone", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: deliverCommand({ commandId: "cmd-lifecycle", kind: "lifecycle" }),
        readModel: makeReadModel({ settledOverride: "settled", snoozedUntil: SNOOZED_UNTIL }),
      });
      const events = Array.isArray(result) ? result : [result];
      // Unread indicator only: a restart notice must not drag a thread the
      // user has parked back into the inbox.
      expect(events.map((event) => event.type)).toEqual(["thread.notification-delivered"]);
    }),
  );

  it.effect("dedupes a replayed deliveryId without appending or waking the thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        // The plugin's retry queue resends with a fresh command id, a new
        // message id, and possibly edited text — only deliveryId is stable.
        command: deliverCommand({
          commandId: "cmd-deliver-retry",
          messageId: "message-retry",
          text: "Digest ready (retry).",
        }),
        readModel: makeReadModel({
          settledOverride: "settled",
          snoozedUntil: SNOOZED_UNTIL,
          messages: [deliveredMessage],
        }),
      });
      const events = Array.isArray(result) ? result : [result];

      // No un-settle/un-snooze: a replay is not new activity.
      expect(events.map((event) => event.type)).toEqual(["thread.notification-delivered"]);

      const delivered = events[0];
      if (delivered?.type === "thread.notification-delivered") {
        // Re-emitted from the persisted row, so reducing it a second time is
        // a byte-identical no-op rather than a duplicate or an overwrite.
        expect(delivered.payload.messageId).toBe("message-1");
        expect(delivered.payload.text).toBe("Digest ready.");
        expect(delivered.payload.createdAt).toBe(DELIVERED_AT);
        expect(delivered.payload.updatedAt).toBe(DELIVERED_AT);
        expect(delivered.occurredAt).toBe(DELIVERED_AT);
      }
    }),
  );

  it.effect("treats a different deliveryId on the same thread as a new delivery", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: deliverCommand({
          commandId: "cmd-deliver-second",
          deliveryId: "delivery-2",
          messageId: "message-2",
          text: "Second digest.",
        }),
        readModel: makeReadModel({
          settledOverride: "settled",
          messages: [deliveredMessage],
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.notification-delivered",
      ]);
      const delivered = events[1];
      if (delivered?.type === "thread.notification-delivered") {
        expect(delivered.payload.messageId).toBe("message-2");
        expect(delivered.payload.notification.deliveryId).toBe("delivery-2");
      }
    }),
  );

  it.effect("threads media attachments and turnId through the delivered payload", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-live");
      const result = yield* decideOrchestrationCommand({
        command: deliverCommand({
          commandId: "cmd-deliver-media",
          deliveryId: "delivery-media",
          messageId: "message-media",
          text: "A caption",
          attachments: [mediaAttachment],
          turnId,
        }),
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(result) ? result : [result];
      const delivered = events.find((event) => event.type === "thread.notification-delivered");
      if (delivered?.type === "thread.notification-delivered") {
        expect(delivered.payload.attachments).toEqual([mediaAttachment]);
        expect(delivered.payload.turnId).toBe(turnId);
      } else {
        expect.unreachable("expected a thread.notification-delivered event");
      }
    }),
  );

  it.effect("rebuilds media replays from the persisted row, not the retry's fields", () =>
    Effect.gen(function* () {
      const persisted: OrchestrationThread["messages"][number] = {
        ...deliveredMessage,
        id: MessageId.make("message-media"),
        text: "A caption",
        turnId: TurnId.make("turn-live"),
        attachments: [mediaAttachment],
        notification: {
          kind: "cron",
          label: "Cron: daily-digest",
          deliveryId: "delivery-media",
        },
      };
      const result = yield* decideOrchestrationCommand({
        // The retry names a different messageId and attachment id — its bytes
        // were written under the original id, so adopting the retry's fields
        // would re-point the row at files that do not exist.
        command: deliverCommand({
          commandId: "cmd-deliver-media-retry",
          deliveryId: "delivery-media",
          messageId: "message-media-retry",
          text: "A caption (retry)",
          attachments: [
            { ...mediaAttachment, id: "thread-1-2c8b3f1e-0000-4000-8000-00000000dead" },
          ],
        }),
        readModel: makeReadModel({ messages: [persisted] }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.notification-delivered"]);
      const delivered = events[0];
      if (delivered?.type === "thread.notification-delivered") {
        expect(delivered.payload.messageId).toBe("message-media");
        expect(delivered.payload.text).toBe("A caption");
        expect(delivered.payload.attachments).toEqual([mediaAttachment]);
        expect(delivered.payload.turnId).toBe("turn-live");
      }
    }),
  );

  it.effect("rejects a delivery for a thread that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          ...deliverCommand({ commandId: "cmd-deliver-missing" }),
          threadId: ThreadId.make("thread-missing"),
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
