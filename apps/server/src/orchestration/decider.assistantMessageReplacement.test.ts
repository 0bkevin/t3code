import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

it.layer(NodeServices.layer)("assistant message replacement", (it) => {
  it.effect("emits a streaming replacement message event", () =>
    Effect.gen(function* () {
      const now = "2026-07-24T12:00:00.000Z";
      const threadId = ThreadId.make("thread-replacement");
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: EventId.make("event-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("command-thread-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-thread-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-replacement"),
          title: "Replacement",
          modelSelection: {
            instanceId: ProviderInstanceId.make("hermes"),
            model: "hermes",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.replace",
          commandId: CommandId.make("command-message-replace"),
          threadId,
          messageId: MessageId.make("assistant:message-1"),
          text: "Hello there",
          turnId: TurnId.make("turn-1"),
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(decided) ? decided[0] : decided;
      if (event?.type !== "thread.message-sent") {
        throw new Error("expected thread.message-sent");
      }
      expect(event.payload.text).toBe("Hello there");
      expect(event.payload.streaming).toBe(true);
      expect(event.payload.textOperation).toBe("replace");
    }),
  );
});
