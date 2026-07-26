import { assert, it } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationProject,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { agentWorkspaceRoot, getOrCreateAgentProject } from "./agentProjects.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const INSTANCE_ID = ProviderInstanceId.make("hermes-siva-local-abc123");
const BASE_DIR = "/tmp/t3-agent-projects-test";

const makeAgentProject = (overrides: Partial<OrchestrationProject> = {}): OrchestrationProject => ({
  id: ProjectId.make("agent-project-1"),
  title: "Hermes Siva Local",
  workspaceRoot: `${BASE_DIR}/agents/${INSTANCE_ID}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  agentInstanceId: INSTANCE_ID,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

/**
 * Query stub whose `getActiveAgentProject` answers from a mutable queue, so a
 * test can model "absent, then present" — the shape every self-healing path
 * here depends on.
 */
const makeQueryLayer = (
  responses: Ref.Ref<ReadonlyArray<Option.Option<OrchestrationProject>>>,
  reads: Ref.Ref<number>,
) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getActiveAgentProject: () =>
      Effect.gen(function* () {
        yield* Ref.update(reads, (count) => count + 1);
        const queue = yield* Ref.get(responses);
        const [head, ...rest] = queue;
        if (head === undefined) {
          return Option.none<OrchestrationProject>();
        }
        yield* Ref.set(responses, rest.length > 0 ? rest : [head]);
        return head;
      }),
    getProjectShellById: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
  });

const makeEngineLayer = (
  dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
  options: { readonly fail?: boolean } = {},
) =>
  Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Ref.update(dispatched, (calls) => [...calls, command]).pipe(
        Effect.andThen(
          options.fail
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: "project.create",
                  detail: "A project already exists for this workspace root.",
                }),
              )
            : Effect.succeed({ sequence: 1 }),
        ),
      ),
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  } as OrchestrationEngine.OrchestrationEngineService["Service"]);

const configLayer = Layer.succeed(ServerConfig, {
  baseDir: BASE_DIR,
} as unknown as ServerConfig["Service"]);

it("derives the workspace root under the T3 home agents directory", () => {
  assert.equal(
    agentWorkspaceRoot({
      baseDir: "/home/user/.t3",
      instanceId: INSTANCE_ID,
      join: (...parts) => parts.join("/"),
    }),
    `/home/user/.t3/agents/${INSTANCE_ID}`,
  );
});

it.effect("returns the existing project without dispatching anything", () =>
  Effect.gen(function* () {
    const existing = makeAgentProject();
    const responses = yield* Ref.make<ReadonlyArray<Option.Option<OrchestrationProject>>>([
      Option.some(existing),
    ]);
    const reads = yield* Ref.make(0);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const project = yield* getOrCreateAgentProject({
      instanceId: INSTANCE_ID,
      title: "Hermes Siva Local",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeQueryLayer(responses, reads),
          makeEngineLayer(dispatched),
          configLayer,
          NodeServices.layer,
        ),
      ),
    );

    assert.equal(project.id, existing.id);
    // The common path must stay a single indexed read — this is called as a
    // precondition on every agent thread start.
    assert.equal(yield* Ref.get(reads), 1);
    assert.deepEqual(yield* Ref.get(dispatched), []);
  }),
);

it.effect("creates the project when none exists yet", () =>
  Effect.gen(function* () {
    const created = makeAgentProject();
    const responses = yield* Ref.make<ReadonlyArray<Option.Option<OrchestrationProject>>>([
      Option.none(),
      Option.some(created),
    ]);
    const reads = yield* Ref.make(0);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const project = yield* getOrCreateAgentProject({
      instanceId: INSTANCE_ID,
      title: "Hermes Siva Local",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeQueryLayer(responses, reads),
          makeEngineLayer(dispatched),
          configLayer,
          NodeServices.layer,
        ),
      ),
    );

    assert.equal(project.id, created.id);
    const commands = yield* Ref.get(dispatched);
    assert.equal(commands.length, 1);
    const command = commands[0];
    assert.equal(command?.type, "project.create");
    if (command?.type === "project.create") {
      assert.equal(command.agentInstanceId, INSTANCE_ID);
      assert.equal(command.createWorkspaceRootIfMissing, true);
      assert.equal(command.workspaceRoot, `${BASE_DIR}/agents/${INSTANCE_ID}`);
      assert.equal(command.title, "Hermes Siva Local");
    }
  }),
);

it.effect("self-heals a soft-deleted project by creating a fresh one", () =>
  Effect.gen(function* () {
    // A soft-deleted row is invisible to `getActiveAgentProject`, so this is
    // indistinguishable from "never created" — which is the point: the
    // instance recovers instead of being permanently unusable.
    const replacement = makeAgentProject({ id: ProjectId.make("agent-project-2") });
    const responses = yield* Ref.make<ReadonlyArray<Option.Option<OrchestrationProject>>>([
      Option.none(),
      Option.some(replacement),
    ]);
    const reads = yield* Ref.make(0);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const project = yield* getOrCreateAgentProject({
      instanceId: INSTANCE_ID,
      title: "Hermes Siva Local",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeQueryLayer(responses, reads),
          makeEngineLayer(dispatched),
          configLayer,
          NodeServices.layer,
        ),
      ),
    );

    assert.equal(project.id, replacement.id);
  }),
);

it.effect("resolves to the winner's project when a concurrent caller wins the race", () =>
  Effect.gen(function* () {
    // The decider rejects a second project on the same workspace root, so the
    // loser sees a dispatch failure. It must re-read and use the winner's row
    // rather than surfacing an error to the user.
    const winner = makeAgentProject({ id: ProjectId.make("agent-project-winner") });
    const responses = yield* Ref.make<ReadonlyArray<Option.Option<OrchestrationProject>>>([
      Option.none(),
      Option.some(winner),
    ]);
    const reads = yield* Ref.make(0);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const project = yield* getOrCreateAgentProject({
      instanceId: INSTANCE_ID,
      title: "Hermes Siva Local",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeQueryLayer(responses, reads),
          makeEngineLayer(dispatched, { fail: true }),
          configLayer,
          NodeServices.layer,
        ),
      ),
    );

    assert.equal(project.id, winner.id);
  }),
);

it.effect("surfaces the dispatch failure when no project appears after it", () =>
  Effect.gen(function* () {
    const responses = yield* Ref.make<ReadonlyArray<Option.Option<OrchestrationProject>>>([
      Option.none(),
    ]);
    const reads = yield* Ref.make(0);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const result = yield* Effect.result(
      getOrCreateAgentProject({ instanceId: INSTANCE_ID, title: "Hermes Siva Local" }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeQueryLayer(responses, reads),
            makeEngineLayer(dispatched, { fail: true }),
            configLayer,
            NodeServices.layer,
          ),
        ),
      ),
    );

    // A genuine failure must not be swallowed by the race-recovery read.
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("falls back to the dispatched row when the projection has not caught up", () =>
  Effect.gen(function* () {
    const responses = yield* Ref.make<ReadonlyArray<Option.Option<OrchestrationProject>>>([
      Option.none(),
    ]);
    const reads = yield* Ref.make(0);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const project = yield* getOrCreateAgentProject({
      instanceId: INSTANCE_ID,
      title: "Hermes Siva Local",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeQueryLayer(responses, reads),
          makeEngineLayer(dispatched),
          configLayer,
          NodeServices.layer,
        ),
      ),
    );

    // Dispatch succeeded but the read-back saw nothing yet: the caller still
    // gets a usable project rather than an error.
    assert.equal(project.agentInstanceId, INSTANCE_ID);
    assert.equal(project.workspaceRoot, `${BASE_DIR}/agents/${INSTANCE_ID}`);
    assert.equal(project.deletedAt, null);
  }),
);

it.effect("falls back to the instance id when the nickname is blank", () =>
  Effect.gen(function* () {
    const responses = yield* Ref.make<ReadonlyArray<Option.Option<OrchestrationProject>>>([
      Option.none(),
    ]);
    const reads = yield* Ref.make(0);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    yield* getOrCreateAgentProject({ instanceId: INSTANCE_ID, title: "   " }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeQueryLayer(responses, reads),
          makeEngineLayer(dispatched),
          configLayer,
          NodeServices.layer,
        ),
      ),
    );

    // `title` is a TrimmedNonEmptyString on the command — a blank nickname
    // would be a decode failure, not a cosmetic problem.
    const command = (yield* Ref.get(dispatched))[0];
    if (command?.type === "project.create") {
      assert.equal(command.title, INSTANCE_ID);
    }
  }),
);
