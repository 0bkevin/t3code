import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HERMES_MEDIA_MAX_BYTES,
  HermesGatewayDeliveryId,
  HermesGatewayRequestId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type HermesGatewayMediaDeliver,
  type HermesGatewayT3ToPluginMessage,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import type { HermesGatewayConnectionRegistration } from "./Services/HermesGatewayBroker.ts";
import { makeHermesDeliveryHandlers } from "./hermesGatewayHttp.ts";

const INSTANCE_ID = ProviderInstanceId.make("hermes-media-test");
const HOME_THREAD_ID = ThreadId.make("thread-home-media");
const SESSION_THREAD_ID = ThreadId.make("thread-live-turn");
const CREATED_AT = "2026-07-27T09:00:00.000Z";

const registration: HermesGatewayConnectionRegistration = {
  instanceId: INSTANCE_ID,
  generation: 1,
  role: "gateway",
  accepted: {
    type: "connection.accepted",
    requestId: HermesGatewayRequestId.make("accept-1"),
    protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
    instanceId: INSTANCE_ID,
    nickname: "Hermes Media",
  },
};

const mediaFrame = (
  overrides: Partial<HermesGatewayMediaDeliver> = {},
): HermesGatewayMediaDeliver =>
  ({
    type: "media.deliver",
    protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
    deliveryId: HermesGatewayDeliveryId.make("media-delivery-1"),
    threadId: HOME_THREAD_ID,
    kind: "cron",
    label: "Cron: daily-digest",
    name: "chart.png",
    mimeType: "image/png",
    sizeBytes: 8,
    caption: "Today's chart",
    data: Buffer.from("PNGBYTES").toString("base64"),
    createdAt: CREATED_AT,
    ...overrides,
  }) as HermesGatewayMediaDeliver;

/** A thread detail carrying one already-written delivery, for dedupe reads. */
const threadWithDelivery = (threadId: ThreadId, deliveryId: string) =>
  ({
    id: threadId,
    messages: [
      {
        id: "message-existing",
        role: "assistant",
        text: "already here",
        turnId: null,
        streaming: false,
        notification: { kind: "cron", label: "Cron: daily-digest", deliveryId },
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
  }) as unknown as OrchestrationThread;

/**
 * The handlers only reach `adapter.hasSession` on the turn-scoped path, so
 * everything else can stay unimplemented.
 */
const instanceTracking = (threadId: ThreadId): ProviderInstance =>
  ({
    instanceId: INSTANCE_ID,
    adapter: {
      hasSession: (candidate: ThreadId) => Effect.succeed(candidate === threadId),
    },
  }) as unknown as ProviderInstance;

const makeHarness = (options?: {
  readonly existingDeliveries?: ReadonlyArray<{ threadId: ThreadId; deliveryId: string }>;
  readonly trackedThreadId?: ThreadId;
  readonly failDispatch?: boolean;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-hermes-media-attachments-",
    });
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const sent: Array<HermesGatewayT3ToPluginMessage> = [];
    const transport = {
      send: (frame: HermesGatewayT3ToPluginMessage) =>
        Effect.sync(() => sent.push(frame)).pipe(Effect.asVoid),
    };

    const engineLayer = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Ref.update(dispatched, (commands) => [...commands, command]).pipe(
          Effect.andThen(
            options?.failDispatch
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: "thread.notification.deliver",
                    detail: "Simulated dispatch failure.",
                  }),
                )
              : Effect.succeed({ sequence: 1 }),
          ),
        ),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    });

    const queryLayer = Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: (threadId) =>
        Effect.succeed(
          Option.fromUndefinedOr(
            options?.existingDeliveries
              ?.filter((entry) => entry.threadId === threadId)
              .map((entry) => threadWithDelivery(entry.threadId, entry.deliveryId))[0],
          ),
        ),
      // The home thread is designated in settings and exists, so home-thread
      // resolution takes the fast path without dispatching a thread.create.
      getThreadArchiveStateById: () => Effect.succeed(Option.some({ archivedAt: null })),
    });

    const registryLayer = Layer.mock(ProviderInstanceRegistry)({
      getInstance: () =>
        Effect.succeed(
          options?.trackedThreadId !== undefined
            ? instanceTracking(options.trackedThreadId)
            : undefined,
        ),
    });

    const settingsLayer = ServerSettings.layerTest({
      providerInstances: {
        [INSTANCE_ID]: {
          driver: "hermes",
          displayName: "Hermes Media",
          config: { homeThreadId: HOME_THREAD_ID },
        },
      },
    } as never);

    // Only `attachmentsDir` is read off the config by the handlers.
    const configLayer = Layer.succeed(ServerConfig, {
      attachmentsDir,
    } as unknown as ServerConfig["Service"]);

    // Provided at invocation too: the handlers resolve the home thread at
    // delivery time, which pulls services from the runtime context.
    const servicesLayer = Layer.mergeAll(
      engineLayer,
      queryLayer,
      registryLayer,
      settingsLayer,
      configLayer,
    ).pipe(Layer.provideMerge(NodeServices.layer));

    const handlers = yield* makeHermesDeliveryHandlers().pipe(Effect.provide(servicesLayer));
    const deliverMedia = (...args: Parameters<typeof handlers.deliverMedia>) =>
      handlers.deliverMedia(...args).pipe(Effect.provide(servicesLayer), Effect.orDie);

    return { deliverMedia, dispatched, sent, transport, attachmentsDir } as const;
  });

const dispatchedDeliveries = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.notification.deliver" }> =>
      command.type === "thread.notification.deliver",
  );

it.effect("writes turnless media to the home thread with provenance and acks after dispatch", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    // The frame's threadId is deliberately NOT the home thread: turnless
    // media must land in the re-resolved home thread regardless.
    yield* harness.deliverMedia(
      registration,
      mediaFrame({ threadId: ThreadId.make("thread-attacker-named") }),
      harness.transport,
    );

    const deliveries = dispatchedDeliveries(yield* Ref.get(harness.dispatched));
    assert.equal(deliveries.length, 1);
    const delivery = deliveries[0]!;
    assert.equal(delivery.threadId, HOME_THREAD_ID);
    assert.equal(delivery.kind, "cron");
    assert.equal(delivery.label, "Cron: daily-digest");
    assert.equal(delivery.text, "Today's chart");
    assert.isUndefined(delivery.turnId);
    assert.equal(delivery.attachments?.length, 1);
    const attachment = delivery.attachments![0]!;
    // image/* rides the image variant so the web's inline grid renders it.
    assert.equal(attachment.type, "image");
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.sizeBytes, 8);

    // The bytes are durably on disk under the dispatched attachment id.
    const fileSystem = yield* FileSystem.FileSystem;
    const entries = yield* fileSystem.readDirectory(harness.attachmentsDir);
    const written = entries.find((entry) => entry.startsWith(attachment.id));
    assert.isDefined(written, "the media bytes must be written to the attachments dir");
    const bytes = yield* fileSystem.readFile(`${harness.attachmentsDir}/${written}`);
    assert.equal(Buffer.from(bytes).toString("utf8"), "PNGBYTES");

    assert.deepEqual(harness.sent, [
      {
        type: "media.deliver.ack",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        deliveryId: mediaFrame().deliveryId,
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("acks a duplicate deliveryId without dispatching a second message", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      existingDeliveries: [{ threadId: HOME_THREAD_ID, deliveryId: "media-delivery-1" }],
    });
    yield* harness.deliverMedia(registration, mediaFrame(), harness.transport);

    assert.equal(dispatchedDeliveries(yield* Ref.get(harness.dispatched)).length, 0);
    // Still acked: the plugin's queue purges only on the ack, and the row is
    // already durably written.
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0]?.type, "media.deliver.ack");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("routes turn-scoped media into the tracked thread and carries the turnId", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ trackedThreadId: SESSION_THREAD_ID });
    const turnId = TurnId.make("hermes-turn-live");
    yield* harness.deliverMedia(
      registration,
      mediaFrame({
        threadId: SESSION_THREAD_ID,
        turnId,
        deliveryId: HermesGatewayDeliveryId.make("media-delivery-turn"),
        mimeType: "video/mp4",
        name: "clip.mp4",
      }),
      harness.transport,
    );

    const delivery = dispatchedDeliveries(yield* Ref.get(harness.dispatched))[0]!;
    assert.equal(delivery.threadId, SESSION_THREAD_ID);
    assert.equal(delivery.turnId, turnId);
    // Non-image media takes the generic file variant.
    assert.equal(delivery.attachments?.[0]?.type, "file");
    assert.equal(harness.sent[0]?.type, "media.deliver.ack");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses turn-scoped media for a thread the adapter does not track", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ trackedThreadId: SESSION_THREAD_ID });
    yield* harness.deliverMedia(
      registration,
      mediaFrame({
        threadId: ThreadId.make("thread-not-ours"),
        turnId: TurnId.make("turn-x"),
      }),
      harness.transport,
    );

    // Refused outright: nothing written, and no ack so the plugin retries
    // (against a session that may exist by then).
    assert.equal(dispatchedDeliveries(yield* Ref.get(harness.dispatched)).length, 0);
    assert.equal(harness.sent.length, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses an oversized decoded payload without writing or acking", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const oversized = Buffer.alloc(HERMES_MEDIA_MAX_BYTES + 4, 1);
    yield* harness.deliverMedia(
      registration,
      mediaFrame({
        data: oversized.toString("base64"),
        sizeBytes: oversized.byteLength,
      }),
      harness.transport,
    );

    assert.equal(dispatchedDeliveries(yield* Ref.get(harness.dispatched)).length, 0);
    assert.equal(harness.sent.length, 0);
    assert.deepEqual(
      yield* (yield* FileSystem.FileSystem).readDirectory(harness.attachmentsDir),
      [],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses a payload whose declared size grossly disagrees with its bytes", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.deliverMedia(registration, mediaFrame({ sizeBytes: 5_000 }), harness.transport);

    assert.equal(dispatchedDeliveries(yield* Ref.get(harness.dispatched)).length, 0);
    assert.equal(harness.sent.length, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not ack media when the dispatch fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ failDispatch: true });
    yield* harness.deliverMedia(registration, mediaFrame(), harness.transport);

    // The plugin keeps the delivery queued and retries on the next connect.
    assert.equal(harness.sent.length, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
