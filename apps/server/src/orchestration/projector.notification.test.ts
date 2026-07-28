import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const CREATED_AT = "2026-07-01T09:00:00.000Z";
const DELIVERED_AT = "2026-07-01T09:05:00.000Z";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly occurredAt: string;
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-home"),
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const threadCreatedEvent = makeEvent({
  sequence: 1,
  type: "thread.created",
  occurredAt: CREATED_AT,
  payload: {
    threadId: ThreadId.make("thread-home"),
    projectId: ProjectId.make("project-1"),
    title: "Home",
    modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
});

const deliveryEvent = makeEvent({
  sequence: 2,
  type: "thread.notification-delivered",
  occurredAt: DELIVERED_AT,
  payload: {
    threadId: ThreadId.make("thread-home"),
    messageId: MessageId.make("notification:msg-1"),
    text: "Digest ready.",
    notification: {
      kind: "cron",
      label: "Cron: daily-digest",
      deliveryId: "delivery-1",
    },
    createdAt: DELIVERED_AT,
    updatedAt: DELIVERED_AT,
  },
});

const expectedMessage = {
  id: "notification:msg-1",
  role: "assistant",
  text: "Digest ready.",
  // A delivery belongs to no turn and is never streamed.
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

it.effect("appends a notification delivery as a turnless assistant message", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(CREATED_AT), threadCreatedEvent);
    const delivered = yield* projectEvent(created, deliveryEvent);

    const thread = delivered.threads[0];
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]).toEqual(expectedMessage);
    expect(thread?.updatedAt).toBe(DELIVERED_AT);
    // Nothing about a delivery touches turn state — attributing it to the
    // thread's live turn would fold it behind that turn's summary.
    expect(thread?.latestTurn).toBeNull();
  }),
);

it.effect("replays a delivery onto the same message instead of duplicating it", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(CREATED_AT), threadCreatedEvent);
    const delivered = yield* projectEvent(created, deliveryEvent);
    // The decider re-emits the persisted row for a replayed deliveryId, so
    // reducing the event twice must be a no-op rather than an append.
    const replayed = yield* projectEvent(delivered, { ...deliveryEvent, sequence: 3 });

    expect(replayed.threads[0]?.messages).toHaveLength(1);
    expect(replayed.threads[0]?.messages[0]).toEqual(expectedMessage);
  }),
);

it.effect("projects media deliveries with attachments and an optional turnId", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(CREATED_AT), threadCreatedEvent);
    const attachment = {
      type: "file",
      id: "thread-home-2c8b3f1e-0000-4000-8000-000000000001",
      name: "chart.mp4",
      mimeType: "video/mp4",
      sizeBytes: 2_048,
    } as const;
    const delivered = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.notification-delivered",
        occurredAt: DELIVERED_AT,
        payload: {
          threadId: ThreadId.make("thread-home"),
          messageId: MessageId.make("notification:media-1"),
          text: "A caption",
          notification: {
            kind: "cron",
            label: "Cron: daily-digest",
            deliveryId: "delivery-media",
          },
          attachments: [attachment],
          turnId: "turn-live",
          createdAt: DELIVERED_AT,
          updatedAt: DELIVERED_AT,
        },
      }),
    );

    const message = delivered.threads[0]?.messages[0];
    expect(message?.attachments).toEqual([attachment]);
    // Turn-scoped media names its turn so it sequences beside the turn's text.
    expect(message?.turnId).toBe("turn-live");
  }),
);

it.effect("keeps deliveries alongside ordinary turn messages", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(CREATED_AT), threadCreatedEvent);
    const withUserMessage = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        occurredAt: "2026-07-01T09:01:00.000Z",
        payload: {
          threadId: ThreadId.make("thread-home"),
          messageId: MessageId.make("msg-user"),
          role: "user",
          text: "hi",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-01T09:01:00.000Z",
          updatedAt: "2026-07-01T09:01:00.000Z",
        },
      }),
    );
    const delivered = yield* projectEvent(withUserMessage, { ...deliveryEvent, sequence: 3 });

    expect(delivered.threads[0]?.messages.map((message) => message.id)).toEqual([
      "msg-user",
      "notification:msg-1",
    ]);
    // Absence of `notification` is what marks an ordinary message; it must
    // never be synthesized onto one.
    expect(delivered.threads[0]?.messages[0]?.notification).toBeUndefined();
  }),
);
