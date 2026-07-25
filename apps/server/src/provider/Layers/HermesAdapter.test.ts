import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HermesGatewayItemId,
  HermesGatewayRequestId,
  HermesGatewaySessionId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type HermesGatewayInstanceStatus,
  type HermesGatewayT3ToPluginMessage,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError } from "../Errors.ts";
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

/**
 * The reconnect trigger is a broker status transition, so these tests drive the
 * broker's two streams directly and never touch a real socket or a clock.
 */
let generationCounter = 0;
const nextGeneration = () => {
  generationCounter += 1;
  return generationCounter;
};
const statusFor = (
  instanceId: ProviderInstanceId,
  status: HermesGatewayInstanceStatus["status"],
  // Defaults to a fresh generation per connected status so a test that just
  // wants "it reconnected" gets one; pass an explicit value to model a
  // republish of the SAME connection (session counts, pings), which must not
  // re-trigger the resume.
  connectionGeneration: number | null = status === "connected" ? nextGeneration() : null,
): HermesGatewayInstanceStatus => ({
  instanceId,
  nickname: "Hermes",
  status,
  connectorUrl: "wss://hermes.example/gateway",
  lastConnectedAt: null,
  pluginVersion: null,
  hermesVersion: null,
  model: null,
  activeSessionCount: 0,
  protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
  capabilities: null,
  connectionGeneration,
});

const collectEvents = (adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> }) =>
  Effect.gen(function* () {
    const seen: Array<ProviderRuntimeEvent> = [];
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        seen.push(event);
      }),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    return { seen, fiber } as const;
  });

/**
 * Fibers settle by explicit rescheduling, never by sleeping: a sleep would make
 * these tests time-dependent and flaky under load.
 */
const drain = Effect.gen(function* () {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    yield* Effect.yieldNow;
  }
});

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

/**
 * Builds an adapter whose broker connectivity and session.ensure response are
 * driven per-test, so a reconnect is expressed as: flip `connected`, decide what
 * the plugin reports on resume, publish a status event.
 */
const makeReconnectHarness = (options: {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly initialSessionId: HermesGatewaySessionId;
}) =>
  Effect.gen(function* () {
    const sent: Array<HermesGatewayT3ToPluginMessage> = [];
    const brokerEvents = yield* PubSub.unbounded<HermesGatewayEnvelope>();
    const brokerStatuses = yield* PubSub.unbounded<HermesGatewayInstanceStatus>();
    const state = {
      connected: true,
      // What the plugin reports on the *next* session.ensure. `undefined`
      // activeTurnId means the plugin no longer knows about any running turn.
      resumeSessionId: options.initialSessionId,
      resumeActiveTurnId: undefined as TurnId | undefined,
      resumeFails: false,
    };
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
          if (state.resumeFails) {
            return Effect.fail(
              new ProviderAdapterRequestError({
                provider: "hermes",
                method: "session.ensure",
                detail: "The Hermes gateway connection disconnected.",
              }),
            );
          }
          return Effect.succeed({
            type: "session.ready",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: message.requestId,
            threadId: message.threadId,
            sessionId: state.resumeSessionId,
            resumed: message.resumeSessionId !== undefined,
            ...(state.resumeActiveTurnId !== undefined
              ? { activeTurnId: state.resumeActiveTurnId }
              : {}),
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
      isConnected: () => Effect.sync(() => state.connected),
      stream: Stream.fromPubSub(brokerEvents),
      streamStatuses: Stream.fromPubSub(brokerStatuses),
    };
    const adapter = yield* makeHermesAdapter({ instanceId: options.instanceId }).pipe(
      Effect.provideService(HermesGatewayBroker, broker),
    );
    yield* Effect.yieldNow;

    const disconnect = Effect.gen(function* () {
      state.connected = false;
      yield* PubSub.publish(brokerStatuses, statusFor(options.instanceId, "offline"));
      yield* drain;
    });
    const reconnect = Effect.gen(function* () {
      state.connected = true;
      yield* PubSub.publish(brokerStatuses, statusFor(options.instanceId, "connected"));
      yield* drain;
    });
    // A plugin restart as it actually happens: the broker accepts the new
    // socket and retires the old one in the same step, so the instance never
    // observably goes offline and only one `connected` status is published.
    const replaceConnection = Effect.gen(function* () {
      state.connected = true;
      yield* PubSub.publish(brokerStatuses, statusFor(options.instanceId, "connected"));
      yield* drain;
    });
    // The same live connection republishing (session counts, pings). Must NOT
    // look like a new connection.
    const republishSameConnection = (generation: number) =>
      Effect.gen(function* () {
        state.connected = true;
        yield* PubSub.publish(
          brokerStatuses,
          statusFor(options.instanceId, "connected", generation),
        );
        yield* drain;
      });

    return {
      adapter,
      sent,
      brokerEvents,
      state,
      disconnect,
      reconnect,
      replaceConnection,
      republishSameConnection,
    } as const;
  });

it.effect("re-issues session.ensure on reconnect and keeps streaming a turn that survived", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_survivor");
    const threadId = ThreadId.make("thread-survivor");
    const initialSessionId = HermesGatewaySessionId.make("session-before-drop");
    const harness = yield* makeReconnectHarness({ instanceId, threadId, initialSessionId });

    yield* harness.adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
    });
    const started = yield* harness.adapter.sendTurn({ threadId, input: "long running work" });
    const { seen, fiber } = yield* collectEvents(harness.adapter);

    // The socket drops mid-turn. Hermes keeps generating: its plugin still
    // holds the turn, so session.ensure reports the same activeTurnId back.
    yield* harness.disconnect;
    harness.state.resumeActiveTurnId = started.turnId;
    yield* harness.reconnect;

    const resumeEnsure = harness.sent.filter((message) => message.type === "session.ensure");
    assert.equal(resumeEnsure.length, 2, "reconnect must re-issue session.ensure");
    const resume = resumeEnsure[1];
    assert.equal(
      resume?.type === "session.ensure" ? resume.resumeSessionId : undefined,
      initialSessionId,
      "resume must carry the stored cursor",
    );

    // The turn survived, so nothing disruptive is emitted and the session keeps
    // pointing at the same turn.
    assert.isUndefined(
      seen.find((event) => event.type === "turn.completed" || event.type === "turn.aborted"),
    );
    const session = (yield* harness.adapter.listSessions())[0];
    assert.equal(session?.status, "running");
    assert.equal(session?.activeTurnId, started.turnId);

    // Deltas for the surviving turn still land after the reconnect.
    yield* PubSub.publish(harness.brokerEvents, {
      instanceId,
      message: {
        type: "content.delta",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId: initialSessionId,
        turnId: started.turnId,
        streamKind: "assistant_text",
        delta: "still going",
      },
    });
    yield* drain;
    assert.isDefined(seen.find((event) => event.type === "content.delta"));

    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Regression: a plugin restart REPLACES the socket rather than leaving a gap.
// The broker accepts the new connection and retires the old one together, so
// the instance never observably goes offline and exactly one `connected`
// status is published. An edge detector watching connectedness therefore never
// fires, T3 keeps a session the new plugin process has never heard of, and its
// next turn.start comes back "Call session.ensure before starting a turn" —
// the thread is dead with no way to recover from the UI.
it.effect("re-issues session.ensure when the connection is replaced without going offline", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_replaced");
    const threadId = ThreadId.make("thread-replaced");
    const initialSessionId = HermesGatewaySessionId.make("session-before-restart");
    const harness = yield* makeReconnectHarness({ instanceId, threadId, initialSessionId });

    // Production ordering: the plugin is already connected and the adapter has
    // observed that connection before any thread exists.
    yield* harness.republishSameConnection(7);

    yield* harness.adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
    });

    // No disconnect: the plugin restarted, so the broker retired the old socket
    // and accepted the new one together. The instance never reports offline.
    yield* harness.replaceConnection;

    const ensures = harness.sent.filter((message) => message.type === "session.ensure");
    assert.equal(
      ensures.length,
      2,
      "a replaced connection must re-ensure, or the next turn is rejected",
    );
    const resume = ensures[1];
    assert.equal(
      resume?.type === "session.ensure" ? resume.resumeSessionId : undefined,
      initialSessionId,
    );

    // A later turn now targets a session the new plugin knows about.
    yield* harness.adapter.sendTurn({ threadId, input: "after the restart" });
    const starts = harness.sent.filter((message) => message.type === "turn.start");
    assert.equal(starts.length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not re-ensure when the same connection republishes its status", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_same_connection");
    const threadId = ThreadId.make("thread-same-connection");
    const harness = yield* makeReconnectHarness({
      instanceId,
      threadId,
      initialSessionId: HermesGatewaySessionId.make("session-stable"),
    });

    // Production ordering: the plugin connects first, so its generation is
    // already known by the time a thread creates a session.
    yield* harness.republishSameConnection(4242);

    yield* harness.adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
    });

    // Session-count reports and ping results republish the SAME connection.
    // Re-ensuring on each would cancel pending approvals under a running turn.
    yield* harness.republishSameConnection(4242);
    yield* harness.republishSameConnection(4242);

    assert.equal(harness.sent.filter((message) => message.type === "session.ensure").length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("settles the thread when a turn does not survive the reconnect", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_dead_turn");
    const threadId = ThreadId.make("thread-dead-turn");
    const initialSessionId = HermesGatewaySessionId.make("session-dead-turn");
    const harness = yield* makeReconnectHarness({ instanceId, threadId, initialSessionId });

    yield* harness.adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
    });
    const started = yield* harness.adapter.sendTurn({ threadId, input: "work that dies" });
    const { seen, fiber } = yield* collectEvents(harness.adapter);

    // The plugin restarted: it comes back with a fresh session and no active
    // turn. Hermes will never send a terminal frame for the old turn, so the
    // adapter must produce one or the thread hangs forever.
    yield* harness.disconnect;
    harness.state.resumeSessionId = HermesGatewaySessionId.make("session-after-restart");
    harness.state.resumeActiveTurnId = undefined;
    yield* harness.reconnect;

    const terminal = seen.find((event) => event.type === "turn.completed");
    assert.isDefined(terminal, "a dead turn must be settled with a terminal event");
    if (terminal?.type === "turn.completed") {
      assert.equal(terminal.turnId, started.turnId);
      assert.equal(terminal.payload.state, "failed");
      assert.include(terminal.payload.errorMessage ?? "", "did not survive");
    }
    const session = (yield* harness.adapter.listSessions())[0];
    assert.isUndefined(session?.activeTurnId);
    assert.equal(session?.status, "error");

    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("settles the thread when session.ensure fails on reconnect", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_resume_failed");
    const threadId = ThreadId.make("thread-resume-failed");
    const initialSessionId = HermesGatewaySessionId.make("session-resume-failed");
    const harness = yield* makeReconnectHarness({ instanceId, threadId, initialSessionId });

    yield* harness.adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
    });
    const started = yield* harness.adapter.sendTurn({ threadId, input: "work" });
    const { seen, fiber } = yield* collectEvents(harness.adapter);

    yield* harness.disconnect;
    harness.state.resumeFails = true;
    yield* harness.reconnect;

    const terminal = seen.find((event) => event.type === "turn.completed");
    assert.isDefined(terminal, "a failed resume must settle rather than hang");
    if (terminal?.type === "turn.completed") {
      assert.equal(terminal.turnId, started.turnId);
      assert.equal(terminal.payload.state, "failed");
      assert.include(terminal.payload.errorMessage ?? "", "could not resume");
    }
    assert.isUndefined((yield* harness.adapter.listSessions())[0]?.activeTurnId);

    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancels pending approvals and user input on reconnect without deciding", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_pending");
    const threadId = ThreadId.make("thread-pending");
    const sessionId = HermesGatewaySessionId.make("session-pending");
    const harness = yield* makeReconnectHarness({
      instanceId,
      threadId,
      initialSessionId: sessionId,
    });

    yield* harness.adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
    });
    const started = yield* harness.adapter.sendTurn({ threadId, input: "needs approval" });
    const { seen, fiber } = yield* collectEvents(harness.adapter);

    yield* PubSub.publish(harness.brokerEvents, {
      instanceId,
      message: {
        type: "request.opened",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: started.turnId,
        requestId: HermesGatewayRequestId.make("approval-in-flight"),
        requestType: "command_execution_approval",
        detail: "Hermes wants to run a command",
      },
    });
    yield* PubSub.publish(harness.brokerEvents, {
      instanceId,
      message: {
        type: "user-input.requested",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: started.turnId,
        requestId: HermesGatewayRequestId.make("clarify-in-flight"),
        questions: [
          {
            id: "clarify-in-flight",
            header: "Hermes",
            question: "Which branch?",
            options: [{ label: "main", description: "main" }],
            multiSelect: false,
          },
        ],
      },
    });
    yield* drain;

    // The plugin restarts and forgets both requests; answering them afterwards
    // would come back `request-not-found` and park the turn forever.
    yield* harness.disconnect;
    harness.state.resumeActiveTurnId = started.turnId;
    yield* harness.reconnect;

    const resolvedApproval = seen.find(
      (event) => event.type === "request.resolved" && event.requestId === "approval-in-flight",
    );
    assert.isDefined(resolvedApproval, "the pending approval must be closed out");
    if (resolvedApproval?.type === "request.resolved") {
      assert.equal(resolvedApproval.payload.requestType, "command_execution_approval");
      // Explicit product decision: never approve or deny on the user's behalf.
      assert.isUndefined(resolvedApproval.payload.decision);
    }
    const resolvedUserInput = seen.find(
      (event) => event.type === "user-input.resolved" && event.requestId === "clarify-in-flight",
    );
    assert.isDefined(resolvedUserInput, "the pending user-input request must be closed out");
    if (resolvedUserInput?.type === "user-input.resolved") {
      assert.deepEqual(resolvedUserInput.payload.answers, {});
    }
    const warning = seen.find((event) => event.type === "runtime.warning");
    assert.isDefined(warning, "the cancellation must be visible in the thread");
    if (warning?.type === "runtime.warning") {
      assert.include(warning.payload.message, "cancelled");
    }

    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails sends immediately and actionably while the gateway is offline", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_offline");
    const threadId = ThreadId.make("thread-offline");
    const sessionId = HermesGatewaySessionId.make("session-offline");
    const harness = yield* makeReconnectHarness({
      instanceId,
      threadId,
      initialSessionId: sessionId,
    });

    yield* harness.adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
    });
    yield* harness.disconnect;
    let sentBefore = harness.sent.length;

    // turn.start path.
    const startError = yield* Effect.flip(
      harness.adapter.sendTurn({ threadId, input: "queue me" }),
    );
    assert.equal(startError._tag, "ProviderAdapterRequestError");
    if (startError._tag === "ProviderAdapterRequestError") {
      assert.include(startError.detail, "Hermes is offline");
      assert.include(startError.detail, instanceId);
      assert.include(startError.detail, "hermes gateway restart");
    }
    // Nothing was queued or dispatched — the failure is immediate, not a
    // deferred send that lands minutes later against a stale thread.
    assert.equal(harness.sent.length, sentBefore);

    // With a turn actually running, the steer and interactive paths must fail
    // just as clearly rather than parking on the broker's request timeout.
    yield* harness.reconnect;
    yield* harness.adapter.sendTurn({ threadId, input: "real work" });
    yield* harness.disconnect;
    sentBefore = harness.sent.length;

    const steerError = yield* Effect.flip(
      harness.adapter.sendTurn({ threadId, input: "steer me" }),
    );
    assert.equal(steerError._tag, "ProviderAdapterRequestError");
    if (steerError._tag === "ProviderAdapterRequestError") {
      assert.include(steerError.detail, "Hermes is offline");
    }

    const interruptError = yield* Effect.flip(harness.adapter.interruptTurn(threadId));
    assert.equal(interruptError._tag, "ProviderAdapterRequestError");

    const approvalError = yield* Effect.flip(
      harness.adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("approval-while-offline"),
        "accept",
      ),
    );
    assert.equal(approvalError._tag, "ProviderAdapterRequestError");

    const userInputError = yield* Effect.flip(
      harness.adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make("clarify-while-offline"),
        {},
      ),
    );
    assert.equal(userInputError._tag, "ProviderAdapterRequestError");

    assert.equal(harness.sent.length, sentBefore);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the session on an undeliverable stop so Hermes is not orphaned", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_stop_offline");
    const threadId = ThreadId.make("thread-stop-offline");
    const sessionId = HermesGatewaySessionId.make("session-stop-offline");
    const harness = yield* makeReconnectHarness({
      instanceId,
      threadId,
      initialSessionId: sessionId,
    });

    yield* harness.adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
    });
    const started = yield* harness.adapter.sendTurn({ threadId, input: "work" });
    const { seen, fiber } = yield* collectEvents(harness.adapter);
    yield* harness.disconnect;

    const stopError = yield* Effect.flip(harness.adapter.stopSession(threadId));
    assert.equal(stopError._tag, "ProviderAdapterRequestError");
    if (stopError._tag === "ProviderAdapterRequestError") {
      assert.include(stopError.detail, "Hermes is offline");
    }
    // The stop never reached Hermes, so dropping local state would orphan a
    // thread that is still running on the far side.
    assert.isTrue(yield* harness.adapter.hasSession(threadId));

    // stopAll (the shutdown finalizer) must not throw away the session either.
    yield* harness.adapter.stopAll();
    assert.isTrue(yield* harness.adapter.hasSession(threadId));

    // Frames that arrive for the still-live session are forwarded with full
    // context rather than dropped or forwarded contextless.
    yield* harness.reconnect;
    yield* PubSub.publish(harness.brokerEvents, {
      instanceId,
      message: {
        type: "content.delta",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: started.turnId,
        streamKind: "assistant_text",
        delta: "still running on Hermes",
      },
    });
    yield* drain;
    assert.isDefined(seen.find((event) => event.type === "content.delta"));

    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("drops frames for a session it no longer tracks", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_forgotten");
    const threadId = ThreadId.make("thread-forgotten");
    const sessionId = HermesGatewaySessionId.make("session-forgotten");
    const harness = yield* makeReconnectHarness({
      instanceId,
      threadId,
      initialSessionId: sessionId,
    });

    yield* harness.adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
    });
    const started = yield* harness.adapter.sendTurn({ threadId, input: "work" });
    yield* harness.adapter.stopSession(threadId);
    const { seen, fiber } = yield* collectEvents(harness.adapter);

    // Hermes had frames in flight when the stop landed. With no session to
    // match, forwarding them would inject content into a forgotten thread.
    yield* PubSub.publish(harness.brokerEvents, {
      instanceId,
      message: {
        type: "content.delta",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: started.turnId,
        streamKind: "assistant_text",
        delta: "orphaned text",
      },
    });
    yield* PubSub.publish(harness.brokerEvents, {
      instanceId,
      message: {
        type: "item.completed",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: started.turnId,
        itemId: HermesGatewayItemId.make("orphan-item"),
        itemType: "command_execution",
      },
    });
    yield* drain;

    assert.equal(seen.length, 0, "frames for an untracked session must not be forwarded");

    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
