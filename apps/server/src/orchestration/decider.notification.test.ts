import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
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
    createdAt: NOW,
  } as const;
}

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
