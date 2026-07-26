import {
  CommandId,
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HermesGatewayConnectionHello,
  HermesGatewayPluginToT3Message,
  HermesGatewayT3ToPluginMessage,
  MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { getOrCreateHomeThread } from "../orchestration/homeThreads.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  HermesGatewayBroker,
  type HermesGatewayConnectionRegistration,
} from "./Services/HermesGatewayBroker.ts";
import { ProviderAdapterRequestError } from "./Errors.ts";

export const HERMES_GATEWAY_WEBSOCKET_PATH = "/api/hermes-gateway/ws";

const decodePluginFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(HermesGatewayPluginToT3Message),
);
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(HermesGatewayT3ToPluginMessage));
const isConnectionHello = Schema.is(HermesGatewayConnectionHello);

export const hermesGatewayWebSocketRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const broker = yield* HermesGatewayBroker;
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const crypto = yield* Crypto.Crypto;

    /**
     * Write one proactive delivery into the instance's home thread and ack it.
     *
     * The ack is sent **only after the dispatch succeeds**. The plugin purges
     * its queued copy on the ack and on nothing else, so acking optimistically
     * would silently drop deliveries whenever a write failed. An unacked
     * delivery is retried on the next connect and deduped there by
     * `deliveryId`, which makes the pessimistic order the safe one.
     *
     * Accepted from either connection role, and deliberately not generation-
     * fenced: a delivery carries no session and cannot conflict with the live
     * connection's turns, and fencing it would reject exactly the out-of-
     * process cron case this exists to serve.
     */
    const deliverHomeNotification = (
      registration: HermesGatewayConnectionRegistration,
      message: Extract<HermesGatewayPluginToT3Message, { readonly type: "home.deliver" }>,
      transport: {
        readonly send: (
          frame: HermesGatewayT3ToPluginMessage,
        ) => Effect.Effect<void, ProviderAdapterRequestError>;
      },
    ) =>
      Effect.gen(function* () {
        // Re-resolve rather than trusting the plugin's threadId: its cached
        // T3_HOME_CHANNEL may name a thread from a previous designation, and a
        // delivery must never land in an arbitrary caller-named thread.
        const homeThreadId = yield* getOrCreateHomeThread({
          instanceId: registration.instanceId,
          title: registration.accepted.nickname,
        });

        // Dedupe here, against the projection, before dispatching.
        //
        // The decider also dedupes, but it can only see the in-memory command
        // read model — which is built with `messages: []` on every thread
        // (`getCommandReadModel`, deliberately, to avoid hydrating message
        // bodies at boot). Its scan therefore matches nothing, and a replay
        // after a server restart appends a second copy. This read hits
        // `projection_thread_messages`, where the delivery actually lives, so
        // it is the check that holds across a restart — exactly the case the
        // plugin's durable queue exists to produce.
        const alreadyDelivered = (threadId: ThreadId) =>
          query.getThreadDetailById(threadId).pipe(
            Effect.map(
              Option.match({
                onNone: () => false,
                onSome: (thread) =>
                  thread.messages.some(
                    (candidate) => candidate.notification?.deliveryId === message.deliveryId,
                  ),
              }),
            ),
            Effect.orElseSucceed(() => false),
          );

        if (!(yield* alreadyDelivered(homeThreadId))) {
          const dispatched = yield* Effect.result(
            engine.dispatch({
              type: "thread.notification.deliver",
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
              threadId: homeThreadId,
              messageId: MessageId.make(yield* crypto.randomUUIDv4),
              deliveryId: message.deliveryId,
              kind: message.kind,
              label: message.label,
              text: message.text,
              createdAt: message.createdAt,
            }),
          );

          // A dispatch failure is not proof the delivery is absent — a racing
          // socket may have won between the read above and this write. Re-read
          // before giving up, or that delivery goes unacked forever and the
          // plugin replays it on every single reconnect.
          if (dispatched._tag === "Failure" && !(yield* alreadyDelivered(homeThreadId))) {
            return yield* Effect.fail(dispatched.failure);
          }
        }

        yield* transport.send({
          type: "home.deliver.ack",
          protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
          deliveryId: message.deliveryId,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          // Deliberately no ack: the plugin keeps the delivery queued and
          // retries it on the next connect.
          Effect.logWarning("Hermes home delivery failed", {
            instanceId: registration.instanceId,
            deliveryId: message.deliveryId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    return HttpRouter.add(
      "GET",
      HERMES_GATEWAY_WEBSOCKET_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const socket = yield* Effect.orDie(request.upgrade);
        const write = yield* socket.writer;
        const registration = yield* Ref.make<Option.Option<HermesGatewayConnectionRegistration>>(
          Option.none(),
        );
        const transport = {
          send: (message: HermesGatewayT3ToPluginMessage) =>
            write(encodeServerFrame(message)).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: "hermes",
                    method: message.type,
                    detail: "Failed to write a Hermes gateway WebSocket frame.",
                    cause,
                  }),
              ),
            ),
          close: (code: number, reason: string) =>
            write(new Socket.CloseEvent(code, reason)).pipe(Effect.ignore),
        };

        yield* socket
          .runString((frame) =>
            Effect.gen(function* () {
              const message = yield* decodePluginFrame(frame);
              const current = yield* Ref.get(registration);

              if (Option.isNone(current)) {
                if (!isConnectionHello(message)) {
                  yield* transport.close(4002, "First message must be connection.hello");
                  return;
                }
                const registered = yield* broker
                  .registerConnection(message, transport)
                  .pipe(
                    Effect.tapError((rejected) =>
                      transport
                        .send(rejected)
                        .pipe(Effect.andThen(transport.close(4003, rejected.message))),
                    ),
                  );
                yield* Ref.set(registration, Option.some(registered));

                // Resolve the home thread here rather than inside
                // `registerConnection`, whose error channel is exactly
                // `connection.rejected`: a thread-creation failure is not a
                // reason to refuse an authenticated plugin. On failure the
                // handshake completes without `homeThreadId`, the plugin keeps
                // whatever designation it already had, and the next connect
                // converges — which is the whole point of converge-on-read.
                const homeThreadId = yield* getOrCreateHomeThread({
                  instanceId: registered.instanceId,
                  title: registered.accepted.nickname,
                }).pipe(
                  Effect.map(Option.some),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("home thread resolution failed", {
                      instanceId: registered.instanceId,
                      cause: Cause.pretty(cause),
                    }).pipe(Effect.as(Option.none<ThreadId>())),
                  ),
                );

                yield* transport.send({
                  ...registered.accepted,
                  ...(Option.isSome(homeThreadId) ? { homeThreadId: homeThreadId.value } : {}),
                });
                return;
              }

              if (isConnectionHello(message)) {
                yield* transport.close(4002, "connection.hello may only be sent once");
                return;
              }

              // Deliveries are handled on the socket that carried them rather
              // than through the broker's event stream, because the ack has to
              // go back to *this* connection — which for an out-of-process cron
              // run is a short-lived delivery socket that no stream subscriber
              // can address.
              if (message.type === "home.deliver") {
                yield* deliverHomeNotification(current.value, message, transport);
                return;
              }

              yield* broker.receive(current.value, message);
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Rejected Hermes gateway WebSocket frame", { cause }).pipe(
                  Effect.andThen(transport.close(4002, "Invalid Hermes gateway message")),
                ),
              ),
            ),
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.logDebug("Hermes gateway WebSocket disconnected", { cause }),
            ),
            Effect.ensuring(
              Ref.get(registration).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.void,
                    onSome: broker.disconnect,
                  }),
                ),
              ),
            ),
          );

        return HttpServerResponse.empty();
      }),
    );
  }),
);
