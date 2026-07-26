// @effect-diagnostics nodeBuiltinImport:off - test fixtures build real SQLite files on disk.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { DevSeedError, seedDevDatabase } from "./dev-seed.ts";

const SEEDED_AT = "2026-07-26T00:00:00.000Z";

/**
 * The subset of the real schema the seeder touches. `monitor_json` is included
 * only in the source, to stand in for the migration drift between an installed
 * app and a worktree that is a migration behind.
 */
function createSchema(
  database: NodeSqlite.DatabaseSync,
  options: { readonly withMonitor: boolean; readonly legacyThreads?: boolean },
) {
  database.exec(`CREATE TABLE projection_projects (
    project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL,
    scripts_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`);
  // A pre-017/023 source has neither archived_at nor latest_user_message_at.
  database.exec(`CREATE TABLE projection_threads (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
    latest_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted_at TEXT${options.legacyThreads ? "" : ", archived_at TEXT, latest_user_message_at TEXT"},
    pending_approval_count INTEGER NOT NULL DEFAULT 0,
    pending_user_input_count INTEGER NOT NULL DEFAULT 0
    ${options.withMonitor ? ", monitor_json TEXT" : ""})`);
  database.exec(`CREATE TABLE projection_thread_messages (
    message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
    text TEXT NOT NULL, is_streaming INTEGER NOT NULL, attachments_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  database.exec(`CREATE TABLE projection_thread_activities (
    activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, tone TEXT NOT NULL,
    kind TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL)`);
  database.exec(`CREATE TABLE projection_thread_sessions (
    thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, provider_name TEXT,
    active_turn_id TEXT, last_error TEXT, updated_at TEXT NOT NULL)`);
  database.exec(`CREATE TABLE projection_turns (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, turn_id TEXT,
    state TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT,
    checkpoint_files_json TEXT NOT NULL,
    UNIQUE (thread_id, turn_id))`);
  database.exec(`CREATE TABLE projection_thread_proposed_plans (
    plan_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, plan_markdown TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  database.exec(`CREATE TABLE projection_pending_approvals (
    request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL)`);
  database.exec(`CREATE TABLE projection_state (
    projector TEXT PRIMARY KEY, last_applied_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
  database.exec(`CREATE TABLE orchestration_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
    stream_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL)`);
  database.exec(`CREATE TABLE provider_session_runtime (
    thread_id TEXT PRIMARY KEY, provider_name TEXT NOT NULL, adapter_key TEXT NOT NULL,
    status TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
}

/** Source DB with `threadCount` threads, oldest first so recency ordering is testable. */
function makeSource(
  path: string,
  threadCount: number,
  activitiesPerThread = 3,
  options?: { readonly legacyThreads?: boolean },
) {
  const legacyThreads = options?.legacyThreads ?? false;
  const database = new NodeSqlite.DatabaseSync(path);
  createSchema(database, { withMonitor: true, legacyThreads });
  database
    .prepare(
      `INSERT INTO projection_projects VALUES ('p1','Project','/repo','[]','${SEEDED_AT}','${SEEDED_AT}',NULL)`,
    )
    .run();

  for (let index = 0; index < threadCount; index += 1) {
    const threadId = `t${String(index)}`;
    // Later index → later timestamp → more recent.
    const at = `2026-07-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`;
    if (legacyThreads) {
      database
        .prepare(
          `INSERT INTO projection_threads (thread_id, project_id, title, latest_turn_id,
           created_at, updated_at, pending_approval_count, pending_user_input_count, monitor_json)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(threadId, "p1", `Thread ${String(index)}`, `turn-${threadId}`, at, at, 4, 2, "{}");
    } else {
      database
        .prepare(
          `INSERT INTO projection_threads (thread_id, project_id, title, latest_turn_id,
           created_at, updated_at, latest_user_message_at, pending_approval_count,
           pending_user_input_count, monitor_json)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(threadId, "p1", `Thread ${String(index)}`, `turn-${threadId}`, at, at, at, 4, 2, "{}");
    }
    // The newest thread is left mid-turn, as a copy taken while an agent is
    // working would be: a running turn with no completion, and a message still
    // streaming into it.
    const midFlight = index === threadCount - 1;
    database
      .prepare(
        `INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json)
         VALUES (?,?,?,?,?,'[]')`,
      )
      .run(
        threadId,
        `turn-${threadId}`,
        midFlight ? "running" : "completed",
        at,
        midFlight ? null : at,
      );
    database
      .prepare(`INSERT INTO projection_thread_sessions VALUES (?,'running','claude',?,'boom',?)`)
      .run(threadId, `turn-${threadId}`, at);
    database
      .prepare(`INSERT INTO projection_thread_messages VALUES (?,?, 'user','hello',?,?,?,?)`)
      .run(
        `m-${threadId}`,
        threadId,
        midFlight ? 1 : 0,
        JSON.stringify([{ type: "image", id: `${threadId}-image`, name: "shot.png" }]),
        at,
        at,
      );
    for (let a = 0; a < activitiesPerThread; a += 1) {
      database
        .prepare(`INSERT INTO projection_thread_activities VALUES (?,?,'neutral','tool','ran',?,?)`)
        .run(`a-${threadId}-${String(a)}`, threadId, "{}", `2026-07-10T00:00:0${String(a)}.000Z`);
    }
  }
  database.close();
}

function makeTarget(path: string, options?: { readonly dropProposedPlans?: boolean }) {
  const database = new NodeSqlite.DatabaseSync(path);
  // No monitor_json: the target is a migration behind, as a worktree often is.
  createSchema(database, { withMonitor: false });
  database
    .prepare(
      `INSERT INTO projection_projects VALUES ('stale','Stale','/old','[]','${SEEDED_AT}','${SEEDED_AT}',NULL)`,
    )
    .run();
  // History from the target's own past life, which must not survive the seed.
  database
    .prepare(`INSERT INTO orchestration_events (event_id, stream_id, event_type, payload_json)
      VALUES ('old-event','stale-thread','thread.created','{}')`)
    .run();
  // A binding for a thread the seed is about to delete.
  database
    .prepare(`INSERT INTO provider_session_runtime
      VALUES ('stale-thread','claude','claude-code','running','${SEEDED_AT}')`)
    .run();
  if (options?.dropProposedPlans) {
    // A target far enough behind that a whole table is missing (migration 013).
    database.exec("DROP TABLE projection_thread_proposed_plans");
  }
  database.close();
}

const withDatabases = <A>(
  run: (paths: { readonly source: string; readonly target: string }) => A,
  options?: {
    readonly threads?: number;
    readonly activities?: number;
    readonly dropProposedPlans?: boolean;
    readonly legacySource?: boolean;
  },
): A => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-seed-"));
  const source = NodePath.join(directory, "source.sqlite");
  const target = NodePath.join(directory, "target.sqlite");
  makeSource(source, options?.threads ?? 5, options?.activities ?? 3, {
    legacyThreads: options?.legacySource ?? false,
  });
  makeTarget(target, { dropProposedPlans: options?.dropProposedPlans ?? false });
  try {
    return run({ source, target });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

const query = <T>(path: string, sql: string): Array<T> => {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).all() as Array<T>;
  } finally {
    database.close();
  }
};

describe("seedDevDatabase", () => {
  it("copies the most recent threads and their project", () => {
    withDatabases(({ source, target }) => {
      const summary = seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 2,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      assert.equal(summary.threads, 2);
      assert.equal(summary.projects, 1);

      const titles = query<{ title: string }>(
        target,
        "SELECT title FROM projection_threads ORDER BY latest_user_message_at DESC",
      ).map((row) => row.title);
      // Threads 4 and 3 are the newest of the five.
      assert.deepStrictEqual(titles, ["Thread 4", "Thread 3"]);
    });
  });

  it("replaces whatever the target held before", () => {
    withDatabases(({ source, target }) => {
      seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 1,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      const projects = query<{ project_id: string }>(
        target,
        "SELECT project_id FROM projection_projects",
      ).map((row) => row.project_id);
      assert.deepStrictEqual(projects, ["p1"]);
    });
  });

  // The target can be a migration behind the source; copying its columns
  // blindly would fail on the first schema change.
  it("skips columns the target does not have", () => {
    withDatabases(({ source, target }) => {
      const summary = seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 1,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      assert.deepStrictEqual(summary.skippedColumns, ["projection_threads.monitor_json"]);
      assert.equal(summary.threads, 1);
    });
  });

  // A copied "running" session has no agent behind it, so the thread would spin
  // forever and the session reaper would skip it.
  it("neutralizes live session state", () => {
    withDatabases(({ source, target }) => {
      seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 3,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      const sessions = query<{ status: string; active_turn_id: string | null }>(
        target,
        "SELECT status, active_turn_id FROM projection_thread_sessions",
      );
      assert.isAbove(sessions.length, 0);
      for (const session of sessions) {
        assert.equal(session.status, "stopped");
        assert.isNull(session.active_turn_id);
      }
    });
  });

  // Approvals are not copied, so the badge counts must not survive.
  it("clears pending counts that have no rows behind them", () => {
    withDatabases(({ source, target }) => {
      seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 3,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      const [counts] = query<{ approvals: number; inputs: number }>(
        target,
        "SELECT SUM(pending_approval_count) approvals, SUM(pending_user_input_count) inputs FROM projection_threads",
      );
      assert.equal(counts?.approvals, 0);
      assert.equal(counts?.inputs, 0);
    });
  });

  // A copied running turn has no agent left to finish it. The session override
  // alone does not cover this: the turn is read independently, and an unsettled
  // one keeps the thread spinning and its timeline unfoldable forever.
  it("settles turns copied mid-flight", () => {
    withDatabases(({ source, target }) => {
      seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 3,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      const turns = query<{ state: string; completed_at: string | null }>(
        target,
        "SELECT state, completed_at FROM projection_turns",
      );
      assert.isAbove(turns.length, 0);
      for (const turn of turns) {
        assert.notEqual(turn.state, "running");
        assert.isNotNull(turn.completed_at);
      }
    });
  });

  // Nothing will ever stream into a copied message, so a carried-over flag
  // renders a caret that never resolves.
  it("clears the streaming flag on copied messages", () => {
    withDatabases(({ source, target }) => {
      seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 3,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      const streaming = query<{ count: number }>(
        target,
        "SELECT COUNT(*) count FROM projection_thread_messages WHERE is_streaming <> 0",
      );
      assert.equal(streaming[0]?.count, 0);
    });
  });

  // The rows carry attachment metadata but the bytes live on disk, so the
  // caller has to be told which files to bring along.
  it("reports the attachment ids the copied messages reference", () => {
    withDatabases(({ source, target }) => {
      const summary = seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 2,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      assert.deepStrictEqual([...summary.attachmentIds].sort(), ["t3-image", "t4-image"]);
    });
  });

  // Bindings are keyed by thread id and are not copied; left behind they name
  // threads the seed just deleted, which the session reaper then tries to stop.
  it("clears provider runtime bindings the seed orphans", () => {
    withDatabases(({ source, target }) => {
      seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 1,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      const [bindings] = query<{ count: number }>(
        target,
        "SELECT COUNT(*) count FROM provider_session_runtime",
      );
      assert.equal(bindings?.count, 0);
    });
  });

  it("caps activities per thread, keeping the newest", () => {
    withDatabases(
      ({ source, target }) => {
        const summary = seedDevDatabase({
          sourceDbPath: source,
          targetDbPath: target,
          threadLimit: 2,
          activityLimit: 2,
          seededAt: SEEDED_AT,
        });

        assert.equal(summary.activities, 4); // 2 threads × 2 kept
        const ids = query<{ activity_id: string }>(
          target,
          "SELECT activity_id FROM projection_thread_activities ORDER BY activity_id",
        ).map((row) => row.activity_id);
        // Of a-*-0/1/2, the newest two are 1 and 2.
        assert.deepStrictEqual(ids, ["a-t3-1", "a-t3-2", "a-t4-1", "a-t4-2"]);
      },
      // One more per thread than the cap keeps, so the cap is observable.
      { activities: 3 },
    );
  });

  // Required, or computeSnapshotSequence reports 0 for every shell snapshot.
  it("writes a cursor row for every projector", () => {
    withDatabases(({ source, target }) => {
      seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 1,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      const rows = query<{ projector: string; last_applied_sequence: number }>(
        target,
        "SELECT projector, last_applied_sequence FROM projection_state",
      );
      assert.equal(rows.length, 9);
      // All at 0. The cursor is exclusive and the event log was emptied, so
      // any positive value would make each projector skip that many of the
      // user's first real events — a different count each, which desynchronizes
      // the projections permanently.
      for (const row of rows) {
        assert.equal(row.last_applied_sequence, 0);
      }
    });
  });

  // The copied projections describe a different world than whatever history
  // the target still holds; replaying it would resurrect the target's own
  // deleted threads and projects over the seed.
  it("empties the target event log", () => {
    withDatabases(({ source, target }) => {
      seedDevDatabase({
        sourceDbPath: source,
        targetDbPath: target,
        threadLimit: 1,
        activityLimit: 10,
        seededAt: SEEDED_AT,
      });

      const [events] = query<{ count: number }>(
        target,
        "SELECT COUNT(*) count FROM orchestration_events",
      );
      assert.equal(events?.count, 0);
    });
  });

  // A target behind on migrations can be missing a table outright; that should
  // degrade like column drift does, not abort the seed.
  it("tolerates a table the target does not have", () => {
    withDatabases(
      ({ source, target }) => {
        const summary = seedDevDatabase({
          sourceDbPath: source,
          targetDbPath: target,
          threadLimit: 2,
          activityLimit: 10,
          seededAt: SEEDED_AT,
        });

        assert.equal(summary.threads, 2);
      },
      { dropProposedPlans: true },
    );
  });

  // The recency columns arrived in migrations 017 and 023; a source older than
  // those must still be readable, since the rest of the copy tolerates drift.
  it("reads a source that predates the recency columns", () => {
    withDatabases(
      ({ source, target }) => {
        const summary = seedDevDatabase({
          sourceDbPath: source,
          targetDbPath: target,
          threadLimit: 2,
          activityLimit: 10,
          seededAt: SEEDED_AT,
        });

        assert.equal(summary.threads, 2);
        const titles = query<{ title: string }>(
          target,
          "SELECT title FROM projection_threads ORDER BY updated_at DESC",
        ).map((row) => row.title);
        assert.deepStrictEqual(titles, ["Thread 4", "Thread 3"]);
      },
      { legacySource: true },
    );
  });

  it("reports a source with nothing to copy", () => {
    withDatabases(
      ({ source, target }) => {
        assert.throws(
          () =>
            seedDevDatabase({
              sourceDbPath: source,
              targetDbPath: target,
              threadLimit: 5,
              activityLimit: 10,
              seededAt: SEEDED_AT,
            }),
          DevSeedError,
        );
      },
      { threads: 0 },
    );
  });

  it("leaves the target untouched when the source cannot be opened", () => {
    withDatabases(({ target }) => {
      assert.throws(
        () =>
          seedDevDatabase({
            sourceDbPath: NodePath.join(NodePath.dirname(target), "missing.sqlite"),
            targetDbPath: target,
            threadLimit: 5,
            activityLimit: 10,
            seededAt: SEEDED_AT,
          }),
        DevSeedError,
      );

      // The pre-existing row survives: nothing was deleted before the failure.
      const projects = query<{ project_id: string }>(
        target,
        "SELECT project_id FROM projection_projects",
      );
      assert.deepStrictEqual(
        projects.map((row) => row.project_id),
        ["stale"],
      );
    });
  });
});
