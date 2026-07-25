import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HermesGatewayRequestId,
  HermesGatewaySessionId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type HermesGatewayT3ToPluginMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  HermesGatewayBroker,
  type HermesGatewayBrokerShape,
  type HermesGatewayEnvelope,
} from "../Services/HermesGatewayBroker.ts";
import {
  makeHermesAdapter,
  sanitizeHermesItemData,
  sanitizeHermesRequestArgs,
} from "./HermesAdapter.ts";

it("sanitizes persisted gateway payloads", () => {
  assert.deepEqual(
    sanitizeHermesItemData("command_execution", {
      command: "git status",
      cwd: "/workspace",
      arbitrarySecret: "drop-me",
      result: { unbounded: true },
    }),
    { command: "git status", cwd: "/workspace" },
  );
  assert.deepEqual(
    sanitizeHermesRequestArgs("command_execution_approval", {
      command: "git push",
      arbitrarySecret: "drop-me",
    }),
    { command: "git push" },
  );
});

it.effect("keeps cwd local while forwarding turn text byte-for-byte and steering follow-ups", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_remote");
    const threadId = ThreadId.make("thread-1");
    const sessionId = HermesGatewaySessionId.make("session-1");
    const sent: Array<HermesGatewayT3ToPluginMessage> = [];
    const brokerEvents = yield* PubSub.unbounded<HermesGatewayEnvelope>();
    const broker: HermesGatewayBrokerShape = {
      createEnrollment: () => Effect.die(new Error("unused")),
      getInstanceStatus: () => Effect.die(new Error("unused")),
      listInstances: Effect.succeed([]),
      renameInstance: () => Effect.die(new Error("unused")),
      revokeInstance: () => Effect.die(new Error("unused")),
      removeInstance: () => Effect.die(new Error("unused")),
      registerConnection: () => Effect.die(new Error("unused")),
      receive: () => Effect.void,
      disconnect: () => Effect.void,
      request: (_instanceId, message) => {
        sent.push(message);
        if (message.type === "session.ensure") {
          return Effect.succeed({
            type: "session.ready",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: message.requestId,
            threadId: message.threadId,
            sessionId,
            resumed: false,
          });
        }
        if (message.type === "turn.start" || message.type === "turn.steer") {
          return Effect.succeed({
            type: "turn.started",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: message.requestId,
            threadId: message.threadId,
            sessionId: message.sessionId,
            turnId: message.turnId,
          });
        }
        return Effect.die(new Error(`unexpected request ${message.type}`));
      },
      send: (_instanceId, message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
      isConnected: () => Effect.succeed(true),
      stream: Stream.fromPubSub(brokerEvents),
      streamStatuses: Stream.empty,
    };
    const adapter = yield* makeHermesAdapter({ instanceId }).pipe(
      Effect.provideService(HermesGatewayBroker, broker),
    );
    yield* Effect.yieldNow;
    const firstEventAfterOrphanExitFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "session.exited",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId: HermesGatewaySessionId.make("session-before-context"),
        recoverable: false,
      },
    });
    const session = yield* adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      cwd: "/must/not/leak",
      runtimeMode: "full-access",
    });
    assert.equal(session.cwd, "/must/not/leak");
    const sessionEnsure = sent.find((message) => message.type === "session.ensure");
    assert.isFalse(sessionEnsure !== undefined && "cwd" in sessionEnsure);

    const original = "  /help keep all whitespace  \n";
    yield* adapter.sendTurn({ threadId, input: original });
    const turnStart = sent.find((message) => message.type === "turn.start");
    assert.equal(turnStart?.type === "turn.start" ? turnStart.text : undefined, original);

    if (!turnStart || turnStart.type !== "turn.start") {
      return yield* Effect.die(new Error("turn.start was not sent"));
    }
    const startEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "turn.started",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: turnStart.requestId,
        threadId,
        sessionId,
        turnId: turnStart.turnId,
      },
    });
    const startEvent = Option.getOrUndefined(yield* Fiber.join(startEventFiber));
    assert.equal(startEvent?.type, "turn.started");
    const firstEventAfterOrphanExit = Option.getOrUndefined(
      yield* Fiber.join(firstEventAfterOrphanExitFiber),
    );
    assert.equal(firstEventAfterOrphanExit?.type, "session.started");

    yield* adapter.sendTurn({ threadId, input: "follow up" });
    const turnSteer = sent.find((message) => message.type === "turn.steer");
    if (!turnSteer || turnSteer.type !== "turn.steer") {
      return yield* Effect.die(new Error("turn.steer was not sent"));
    }
    const steerEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "turn.started",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: turnSteer.requestId,
        threadId,
        sessionId,
        turnId: turnSteer.turnId,
      },
    });
    const steerEvent = Option.getOrUndefined(yield* Fiber.join(steerEventFiber));
    assert.equal(steerEvent?.type, "turn.started");

    const nextEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "content.delta",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: turnSteer.turnId,
        streamKind: "assistant_text",
        delta: "continued",
      },
    });
    const nextEvent = Option.getOrUndefined(yield* Fiber.join(nextEventFiber));
    assert.equal(nextEvent?.type, "content.delta");

    const newerTurnId = TurnId.make("newer-turn");
    const newerTurnFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "turn.started",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: HermesGatewayRequestId.make("newer-turn-request"),
        threadId,
        sessionId,
        turnId: newerTurnId,
      },
    });
    yield* Fiber.join(newerTurnFiber);

    const afterStaleExitFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "session.exited",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId: HermesGatewaySessionId.make("session-stale"),
        recoverable: false,
      },
    });
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "content.delta",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: newerTurnId,
        streamKind: "assistant_text",
        delta: "still active",
      },
    });
    const afterStaleExit = Option.getOrUndefined(yield* Fiber.join(afterStaleExitFiber));
    assert.equal(afterStaleExit?.type, "content.delta");
    const afterStaleExitSession = (yield* adapter.listSessions())[0];
    assert.equal(afterStaleExitSession?.status, "running");
    assert.equal(afterStaleExitSession?.activeTurnId, newerTurnId);

    const staleCompletionFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "turn.completed",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: turnStart.turnId,
        state: "completed",
      },
    });
    yield* Fiber.join(staleCompletionFiber);

    const afterStaleCompletion = (yield* adapter.listSessions())[0];
    assert.equal(afterStaleCompletion?.status, "running");
    assert.equal(afterStaleCompletion?.activeTurnId, newerTurnId);

    const activeCompletionFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "turn.completed",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: newerTurnId,
        state: "completed",
      },
    });
    yield* Fiber.join(activeCompletionFiber);

    const afterActiveCompletion = (yield* adapter.listSessions())[0];
    assert.equal(afterActiveCompletion?.status, "ready");
    assert.equal(afterActiveCompletion?.activeTurnId, undefined);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("resumes active Hermes turns for steering and projects authoritative snapshots", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_reconnected");
    const threadId = ThreadId.make("thread-reconnected");
    const sessionId = HermesGatewaySessionId.make("session-reconnected");
    const activeTurnId = TurnId.make("turn-already-running");
    const sent: Array<HermesGatewayT3ToPluginMessage> = [];
    const brokerEvents = yield* PubSub.unbounded<HermesGatewayEnvelope>();
    const broker: HermesGatewayBrokerShape = {
      createEnrollment: () => Effect.die(new Error("unused")),
      getInstanceStatus: () => Effect.die(new Error("unused")),
      listInstances: Effect.succeed([]),
      renameInstance: () => Effect.die(new Error("unused")),
      revokeInstance: () => Effect.die(new Error("unused")),
      removeInstance: () => Effect.die(new Error("unused")),
      registerConnection: () => Effect.die(new Error("unused")),
      receive: () => Effect.void,
      disconnect: () => Effect.void,
      request: (_instanceId, message) => {
        sent.push(message);
        if (message.type === "session.ensure") {
          return Effect.succeed({
            type: "session.ready",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: message.requestId,
            threadId: message.threadId,
            sessionId,
            resumed: true,
            activeTurnId,
          });
        }
        if (message.type === "turn.steer") {
          return Effect.succeed({
            type: "turn.started",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: message.requestId,
            threadId: message.threadId,
            sessionId: message.sessionId,
            turnId: message.turnId,
          });
        }
        return Effect.die(new Error(`unexpected request ${message.type}`));
      },
      send: (_instanceId, message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
      isConnected: () => Effect.succeed(true),
      stream: Stream.fromPubSub(brokerEvents),
      streamStatuses: Stream.empty,
    };
    const adapter = yield* makeHermesAdapter({ instanceId }).pipe(
      Effect.provideService(HermesGatewayBroker, broker),
    );
    yield* Effect.yieldNow;

    const session = yield* adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      resumeCursor: {
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        sessionId,
      },
    });
    assert.equal(session.status, "running");
    assert.equal(session.activeTurnId, activeTurnId);

    yield* adapter.sendTurn({ threadId, input: "steer the restored turn" });
    const steer = sent.find((message) => message.type === "turn.steer");
    assert.equal(steer?.type === "turn.steer" ? steer.turnId : undefined, activeTurnId);

    const snapshotEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "content.snapshot",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: activeTurnId,
        streamKind: "assistant_text",
        text: "the complete restored answer",
        contentIndex: 0,
      },
    });
    const snapshotEvent = Option.getOrUndefined(yield* Fiber.join(snapshotEventFiber));
    assert.equal(snapshotEvent?.type, "content.snapshot");
    if (snapshotEvent?.type === "content.snapshot") {
      assert.deepEqual(snapshotEvent.payload, {
        streamKind: "assistant_text",
        text: "the complete restored answer",
        contentIndex: 0,
      });
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
