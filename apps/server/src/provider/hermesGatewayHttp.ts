import {
  CommandId,
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HERMES_MEDIA_MAX_BYTES,
  HermesGatewayConnectionHello,
  HermesGatewayPluginToT3Message,
  HermesGatewayT3ToPluginMessage,
  MessageId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { getOrCreateHomeThread } from "../orchestration/homeThreads.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  HermesGatewayBroker,
  type HermesGatewayConnectionRegistration,
} from "./Services/HermesGatewayBroker.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderAdapterRequestError } from "./Errors.ts";

export const HERMES_GATEWAY_WEBSOCKET_PATH = "/api/hermes-gateway/ws";

const decodePluginFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(HermesGatewayPluginToT3Message),
);
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(HermesGatewayT3ToPluginMessage));
const isConnectionHello = Schema.is(HermesGatewayConnectionHello);

interface HermesDeliveryTransport {
  readonly send: (
    frame: HermesGatewayT3ToPluginMessage,
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
}

/**
 * Build the durable-write-then-ack handlers for plugin-initiated deliveries.
 *
 * A factory rather than route-inlined closures so the delivery contract —
 * dedupe, pessimistic ack, thread resolution — is testable without standing
 * up a WebSocket route around it.
 */
export const makeHermesDeliveryHandlers = Effect.fn("makeHermesDeliveryHandlers")(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const registry = yield* ProviderInstanceRegistry;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  // Dedupe against the projection, before dispatching.
  //
  // The decider also dedupes, but it can only see the in-memory command
  // read model — which is built with `messages: []` on every thread
  // (`getCommandReadModel`, deliberately, to avoid hydrating message
  // bodies at boot). Its scan therefore matches nothing, and a replay
  // after a server restart appends a second copy. This read hits
  // `projection_thread_messages`, where the delivery actually lives, so
  // it is the check that holds across a restart — exactly the case the
  // plugin's durable queue exists to produce.
  //
  // Deliberately NOT `getThreadDetailById`: that read filters `archived_at
  // IS NULL`, so an archived Home reported every delivery as new. Combined
  // with a failed un-archive (best-effort by design in `getOrCreateHomeThread`)
  // that turned the plugin's retry loop into an append loop — one row per
  // reconnect, all acked. This is the only durable dedupe after a restart, so
  // it has to be archive-independent.
  const alreadyDelivered = (threadId: ThreadId, deliveryId: string) =>
    query
      .hasThreadNotificationDelivery({ threadId, deliveryId })
      .pipe(Effect.orElseSucceed(() => false));

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
    transport: HermesDeliveryTransport,
  ) =>
    Effect.gen(function* () {
      // Re-resolve rather than trusting the plugin's threadId: its cached
      // T3_HOME_CHANNEL may name a thread from a previous designation, and a
      // delivery must never land in an arbitrary caller-named thread.
      const homeThreadId = yield* getOrCreateHomeThread({
        instanceId: registration.instanceId,
        title: registration.accepted.nickname,
      });

      if (!(yield* alreadyDelivered(homeThreadId, message.deliveryId))) {
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
        if (
          dispatched._tag === "Failure" &&
          !(yield* alreadyDelivered(homeThreadId, message.deliveryId))
        ) {
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

  /**
   * Write one media delivery — bytes to the attachment store, then a
   * notification-shaped message row — and ack it.
   *
   * The same pessimistic contract as `deliverHomeNotification`: the ack is
   * sent only after the dispatch succeeds, an unacked delivery is retried
   * and deduped on `deliveryId`, and both connection roles are accepted.
   *
   * Thread resolution is scope-dependent:
   * - `turnId` present — media produced during a live turn. The frame's
   *   threadId is honored only if this instance's adapter actually tracks a
   *   session for it; anything else is refused, so a confused plugin cannot
   *   spray files into arbitrary threads.
   * - turnless — proactive media. The threadId is advisory exactly as it is
   *   for `home.deliver`: the server re-resolves the instance's home thread
   *   and writes only there.
   */
  const deliverMedia = (
    registration: HermesGatewayConnectionRegistration,
    message: Extract<HermesGatewayPluginToT3Message, { readonly type: "media.deliver" }>,
    transport: HermesDeliveryTransport,
  ) =>
    Effect.gen(function* () {
      const bytes = Buffer.from(message.data, "base64");
      // The schema bounds the encoded string; re-check the decoded bytes so
      // a frame whose base64 hides more than the ceiling (or whose declared
      // size lies) is refused before anything is written. `sizeBytes` only
      // needs to be honest, not exact — base64 length is ambiguous by up to
      // 2 bytes of padding.
      if (bytes.byteLength === 0 || bytes.byteLength > HERMES_MEDIA_MAX_BYTES) {
        return yield* Effect.fail(
          new ProviderAdapterRequestError({
            provider: "hermes",
            method: "media.deliver",
            detail: `Media payload is empty or exceeds ${HERMES_MEDIA_MAX_BYTES} bytes after decoding.`,
          }),
        );
      }
      if (Math.abs(bytes.byteLength - message.sizeBytes) > 2) {
        return yield* Effect.fail(
          new ProviderAdapterRequestError({
            provider: "hermes",
            method: "media.deliver",
            detail: `Media payload decoded to ${bytes.byteLength} bytes but declared ${message.sizeBytes}.`,
          }),
        );
      }

      const threadId = yield* Effect.gen(function* () {
        if (message.turnId === undefined) {
          // Proactive: re-resolve, never trust the frame (see doc above).
          return yield* getOrCreateHomeThread({
            instanceId: registration.instanceId,
            title: registration.accepted.nickname,
          });
        }
        // Turn-scoped: the named thread must be one this instance's adapter
        // holds a live session for.
        const instance = yield* registry.getInstance(registration.instanceId);
        const tracked =
          instance !== undefined && (yield* instance.adapter.hasSession(message.threadId));
        if (!tracked) {
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: "hermes",
              method: "media.deliver",
              detail: `Turn-scoped media names thread '${message.threadId}', which this instance has no session for.`,
            }),
          );
        }
        return message.threadId;
      });

      if (!(yield* alreadyDelivered(threadId, message.deliveryId))) {
        const mimeType = message.mimeType.trim().toLowerCase();
        const attachmentId = createAttachmentId(threadId);
        if (!attachmentId) {
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: "hermes",
              method: "media.deliver",
              detail: "Failed to create a safe attachment id.",
            }),
          );
        }
        // Images take the image variant so they ride the existing inline
        // grid; the image schema caps sizeBytes at 10MB, so a larger image
        // degrades to the generic file card rather than being refused.
        const attachment: ChatAttachment =
          mimeType.startsWith("image/") && bytes.byteLength <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            ? {
                type: "image",
                id: attachmentId,
                name: message.name,
                mimeType,
                sizeBytes: bytes.byteLength,
              }
            : {
                type: "file",
                id: attachmentId,
                name: message.name,
                mimeType,
                sizeBytes: bytes.byteLength,
              };

        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: "hermes",
              method: "media.deliver",
              detail: `Failed to resolve a persisted path for '${message.name}'.`,
            }),
          );
        }
        // Bytes before row, deliberately: a row pointing at a missing file
        // renders broken forever, while an orphaned file from a failed
        // dispatch is retried under a fresh id and merely leaks bytes.
        yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
        yield* fileSystem.writeFile(attachmentPath, bytes);

        const dispatched = yield* Effect.result(
          engine.dispatch({
            type: "thread.notification.deliver",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            messageId: MessageId.make(yield* crypto.randomUUIDv4),
            deliveryId: message.deliveryId,
            kind: message.kind,
            label: message.label,
            // The caption is the row's text; empty is fine — the schema
            // allows it and the web renders media-only rows without a body.
            text: message.caption ?? "",
            attachments: [attachment],
            ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
            createdAt: message.createdAt,
          }),
        );

        // Same racing-socket rule as home deliveries: re-read before giving
        // up, or the delivery goes unacked forever.
        if (
          dispatched._tag === "Failure" &&
          !(yield* alreadyDelivered(threadId, message.deliveryId))
        ) {
          return yield* Effect.fail(dispatched.failure);
        }
      }

      yield* transport.send({
        type: "media.deliver.ack",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        deliveryId: message.deliveryId,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        // Deliberately no ack: the plugin keeps the delivery queued and
        // retries it on the next connect.
        Effect.logWarning("Hermes media delivery failed", {
          instanceId: registration.instanceId,
          deliveryId: message.deliveryId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  return { deliverHomeNotification, deliverMedia } as const;
});

export const hermesGatewayWebSocketRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const broker = yield* HermesGatewayBroker;
    const { deliverHomeNotification, deliverMedia } = yield* makeHermesDeliveryHandlers();

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

              if (message.type === "media.deliver") {
                yield* deliverMedia(current.value, message, transport);
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
