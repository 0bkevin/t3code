/**
 * Copies recent projects and threads from one T3 Code database into another, so
 * an isolated dev server opens on something recognisable instead of an empty
 * sidebar.
 *
 * Projections only — no event history is copied, and the target's own log is
 * emptied. The copied projections describe a different world than whatever the
 * target recorded, so replaying its retained events over them would resurrect
 * threads and projects it had deleted; copying a *partial* source range is
 * worse still, since the projector would replay a tail whose creating events
 * are missing. With the log empty and every projector cursor at 0, bootstrap
 * streams nothing and leaves the copied rows alone.
 *
 * Everything that would otherwise wait on an agent is settled too — sessions,
 * turns, streaming messages, badge counts, provider bindings — because no agent
 * process comes with the copy. See
 * .agents/skills/test-t3-app/references/sqlite-fixtures.md.
 */

import * as NodeSqlite from "node:sqlite";

import { PROJECTION_TABLES_IN_DEPENDENCY_ORDER, PROJECTOR_NAMES } from "./projection-tables.ts";

export interface DevSeedOptions {
  readonly sourceDbPath: string;
  readonly targetDbPath: string;
  /** How many recent threads to copy. */
  readonly threadLimit: number;
  /**
   * Newest activities kept per thread. The real table runs to six figures, and
   * the tail is what makes a thread look alive, so a cap keeps the copy quick
   * without making it look empty.
   */
  readonly activityLimit: number;
  /** ISO-8601 timestamp stamped on the projector cursor rows. */
  readonly seededAt: string;
}

export interface DevSeedSummary {
  readonly projects: number;
  readonly threads: number;
  readonly messages: number;
  readonly activities: number;
  readonly turns: number;
  readonly sessions: number;
  readonly skippedColumns: ReadonlyArray<string>;
  /**
   * Attachment ids the copied messages reference. The rows carry the metadata
   * but the bytes live on disk beside the database, so the caller has to copy
   * those files too — otherwise a seeded thread renders an image that 404s.
   */
  readonly attachmentIds: ReadonlyArray<string>;
}

export class DevSeedError extends Error {
  override readonly name = "DevSeedError";
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

const columnsOf = (database: NodeSqlite.DatabaseSync, table: string): ReadonlyArray<string> =>
  database
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(table)
    .map((row) => String((row as { name: unknown }).name));

/**
 * Columns present in both databases. The two can sit on different migrations —
 * a dev worktree is often a migration behind or ahead of the installed app — so
 * `SELECT *` would fail on the first schema change. Copying the intersection
 * degrades gracefully instead: a column only the target knows about keeps its
 * default.
 */
function sharedColumns(
  source: NodeSqlite.DatabaseSync,
  target: NodeSqlite.DatabaseSync,
  table: string,
): { readonly shared: ReadonlyArray<string>; readonly skipped: ReadonlyArray<string> } {
  const sourceColumns = columnsOf(source, table);
  const targetColumns = new Set(columnsOf(target, table));
  const shared = sourceColumns.filter((column) => targetColumns.has(column));
  const skipped = sourceColumns
    .filter((column) => !targetColumns.has(column))
    .map((column) => `${table}.${column}`);
  return { shared, skipped };
}

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

const hasTable = (database: NodeSqlite.DatabaseSync, table: string): boolean =>
  database.prepare(`SELECT 1 FROM pragma_table_info(?)`).get(table) !== undefined;

const hasColumn = (database: NodeSqlite.DatabaseSync, table: string, column: string): boolean =>
  columnsOf(database, table).includes(column);

/**
 * Attachment ids referenced by the copied messages, so the caller can copy the
 * files that back them. `attachments_json` is a JSON array of ChatAttachment
 * (packages/contracts/src/orchestration.ts); anything unparseable is skipped
 * rather than failing the seed, since a missing image is a cosmetic problem and
 * an aborted seed is not.
 */
function collectAttachmentIds(
  target: NodeSqlite.DatabaseSync,
  threadIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (
    threadIds.length === 0 ||
    !hasColumn(target, "projection_thread_messages", "attachments_json")
  ) {
    return [];
  }
  const ids = new Set<string>();
  const rows = target
    .prepare(
      `SELECT attachments_json FROM projection_thread_messages
       WHERE attachments_json IS NOT NULL AND thread_id IN (${placeholders(threadIds.length)})`,
    )
    .iterate(...threadIds) as Iterable<{ attachments_json: unknown }>;
  for (const row of rows) {
    if (typeof row.attachments_json !== "string") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(row.attachments_json);
      if (!Array.isArray(parsed)) {
        continue;
      }
      for (const attachment of parsed) {
        const id: unknown = (attachment as { id?: unknown } | null)?.id;
        if (typeof id === "string" && id.length > 0) {
          ids.add(id);
        }
      }
    } catch {
      // A row whose JSON does not parse cannot name a file to copy.
    }
  }
  return [...ids];
}

/**
 * Copies rows for `table` whose `keyColumn` is in `keys`, optionally keeping
 * only the newest `perKeyLimit` rows per key.
 */
function copyRows(input: {
  readonly source: NodeSqlite.DatabaseSync;
  readonly target: NodeSqlite.DatabaseSync;
  readonly table: string;
  readonly keyColumn: string;
  readonly keys: ReadonlyArray<string>;
  readonly omitColumns?: ReadonlyArray<string>;
  readonly perKeyLimit?: { readonly orderBy: string; readonly limit: number };
  readonly overrides?: Readonly<Record<string, unknown>>;
}): { readonly copied: number; readonly skipped: ReadonlyArray<string> } {
  if (input.keys.length === 0) {
    return { copied: 0, skipped: [] };
  }

  const { shared, skipped } = sharedColumns(input.source, input.target, input.table);
  const omit = new Set(input.omitColumns ?? []);
  const columns = shared.filter((column) => !omit.has(column));
  if (columns.length === 0) {
    return { copied: 0, skipped };
  }

  const selectList = columns.map((column) => `"${column}"`).join(", ");
  // OR REPLACE never fires after the wholesale DELETE, but keeps the copy
  // robust if the delete list and the copy list ever drift apart.
  const insert = input.target.prepare(
    `INSERT OR REPLACE INTO ${input.table} (${selectList}) VALUES (${placeholders(columns.length)})`,
  );
  const overrides = input.overrides ?? {};
  let copied = 0;
  // Iterate rather than materialize: messages are uncapped, and buffering
  // every row of a large copy into a JS array costs memory for nothing —
  // the target transaction is already open.
  const insertFrom = (rows: Iterable<unknown>) => {
    for (const row of rows as Iterable<Record<string, unknown>>) {
      insert.run(
        ...columns.map((column) => {
          const value = Object.hasOwn(overrides, column) ? overrides[column] : row[column];
          // node:sqlite binds only null/number/bigint/string/Uint8Array; every
          // projection column is one of those, and undefined means "absent".
          return (value ?? null) as null | number | bigint | string | Uint8Array;
        }),
      );
      copied += 1;
    }
  };

  if (input.perKeyLimit) {
    // Per-key cap: one bounded query per key beats a window function — the
    // (thread_id, created_at) index lets each query walk backwards and stop
    // at the limit instead of ranking every row.
    const statement = input.source.prepare(
      `SELECT ${selectList} FROM ${input.table} WHERE "${input.keyColumn}" = ?
       ORDER BY ${input.perKeyLimit.orderBy} DESC LIMIT ?`,
    );
    for (const key of input.keys) {
      insertFrom(statement.iterate(key, input.perKeyLimit.limit));
    }
  } else {
    insertFrom(
      input.source
        .prepare(
          `SELECT ${selectList} FROM ${input.table} WHERE "${input.keyColumn}" IN (${placeholders(input.keys.length)})`,
        )
        .iterate(...input.keys),
    );
  }

  return { copied, skipped };
}

/**
 * Settles turns copied mid-flight, matching what the server does to a turn
 * whose session leaves "running": `settledTurnStateForSessionStatus` in
 * apps/server/src/orchestration/Layers/ProjectionPipeline.ts maps the "stopped"
 * status the sessions are copied with to "interrupted".
 *
 * An UPDATE rather than a copy override, because only the rows that were
 * actually running should change; the rest keep their real recorded state.
 */
function settleRunningTurns(
  target: NodeSqlite.DatabaseSync,
  threadIds: ReadonlyArray<string>,
): void {
  if (threadIds.length === 0 || !hasColumn(target, "projection_turns", "state")) {
    return;
  }
  // completed_at is what marks a turn settled alongside its state; a running
  // turn has none, and leaving it null keeps the thread unsettled regardless.
  const setCompletedAt = hasColumn(target, "projection_turns", "completed_at")
    ? `, completed_at = COALESCE(completed_at, requested_at)`
    : "";
  target
    .prepare(
      `UPDATE projection_turns SET state = 'interrupted'${setCompletedAt}
       WHERE state = 'running' AND thread_id IN (${placeholders(threadIds.length)})`,
    )
    .run(...threadIds);
}

export function seedDevDatabase(options: DevSeedOptions): DevSeedSummary {
  let source: NodeSqlite.DatabaseSync;
  try {
    source = new NodeSqlite.DatabaseSync(options.sourceDbPath, { readOnly: true });
  } catch (cause) {
    throw new DevSeedError(
      `could not open the source database at ${options.sourceDbPath}`,
      `${String(cause)}. Has T3 Code run at least once?`,
    );
  }

  let target: NodeSqlite.DatabaseSync;
  try {
    target = new NodeSqlite.DatabaseSync(options.targetDbPath);
  } catch (cause) {
    source.close();
    throw new DevSeedError(
      `could not open the target database at ${options.targetDbPath}`,
      `${String(cause)}. Start the dev server once so migrations run, then retry.`,
    );
  }

  try {
    // Threads the user actually touched most recently. Mirrors the sidebar's own
    // ordering (packages/client-runtime/src/state/threadSort.ts). Both recency
    // columns arrived in later migrations, so an older source database is read
    // with whichever of them it actually has — the rest of the copy tolerates
    // schema drift, and this query must too.
    const recencyColumns = ["latest_user_message_at", "updated_at", "created_at"].filter((column) =>
      hasColumn(source, "projection_threads", column),
    );
    const activeFilters = ["deleted_at", "archived_at"]
      .filter((column) => hasColumn(source, "projection_threads", column))
      .map((column) => `${column} IS NULL`);
    const threadIds = (
      source
        .prepare(
          `SELECT thread_id FROM projection_threads
           ${activeFilters.length > 0 ? `WHERE ${activeFilters.join(" AND ")}` : ""}
           ORDER BY COALESCE(${recencyColumns.join(", ")}) DESC
           LIMIT ?`,
        )
        .all(options.threadLimit) as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);

    if (threadIds.length === 0) {
      throw new DevSeedError(
        "the source database has no active threads to copy",
        "Use T3 Code normally first, or point --from at a different data directory.",
      );
    }

    const projectIds = (
      source
        .prepare(
          `SELECT DISTINCT project_id FROM projection_threads
           WHERE thread_id IN (${placeholders(threadIds.length)})`,
        )
        .all(...threadIds) as Array<{ project_id: string }>
    ).map((row) => row.project_id);

    const skipped: Array<string> = [];
    const record = (result: {
      readonly copied: number;
      readonly skipped: ReadonlyArray<string>;
    }) => {
      skipped.push(...result.skipped);
      return result.copied;
    };

    target.exec("BEGIN IMMEDIATE");

    for (const table of PROJECTION_TABLES_IN_DEPENDENCY_ORDER) {
      // A target behind on migrations may not have every table yet; skipping is
      // consistent with how column drift is handled, and beats aborting the seed.
      if (hasTable(target, table)) {
        target.exec(`DELETE FROM ${table}`);
      }
    }

    // Projections are copied wholesale, so any event history the target still
    // holds describes a different world. Replaying it over the copied rows
    // would resurrect the target's own deleted threads and projects.
    if (hasTable(target, "orchestration_events")) {
      target.exec("DELETE FROM orchestration_events");
    }
    if (hasTable(target, "orchestration_command_receipts")) {
      target.exec("DELETE FROM orchestration_command_receipts");
    }
    // Provider bindings are keyed by thread id and are not copied (no agent
    // process comes with the seed). Left in place they outlive the threads they
    // name: ProviderSessionReaper sweeps every non-stopped binding, finds no
    // thread behind it, and so never hits its active-turn guard — it just tries
    // to stop a session for a thread that no longer exists, against a provider
    // instance this worktree may not even define.
    if (hasTable(target, "provider_session_runtime")) {
      target.exec("DELETE FROM provider_session_runtime");
    }

    const projects = record(
      copyRows({
        source,
        target,
        table: "projection_projects",
        keyColumn: "project_id",
        keys: projectIds,
      }),
    );
    const threads = record(
      copyRows({
        source,
        target,
        table: "projection_threads",
        keyColumn: "thread_id",
        keys: threadIds,
        // Approvals are not copied (see below), so the badge must not claim any.
        overrides: { pending_approval_count: 0, pending_user_input_count: 0 },
      }),
    );
    // row_id is an AUTOINCREMENT surrogate; let the target assign its own.
    const turns = record(
      copyRows({
        source,
        target,
        table: "projection_turns",
        keyColumn: "thread_id",
        keys: threadIds,
        omitColumns: ["row_id"],
      }),
    );
    // A thread copied mid-turn has no agent to finish it. The session status is
    // forced to "stopped" below, but the turn is read independently: a
    // `state = 'running'` turn keeps the thread unsettled and unfoldable
    // forever (deriveUnsettledTurnId in MessagesTimeline.logic.ts). Interrupted
    // is what the server itself settles an abandoned turn to.
    settleRunningTurns(target, threadIds);
    const messages = record(
      copyRows({
        source,
        target,
        table: "projection_thread_messages",
        keyColumn: "thread_id",
        keys: threadIds,
        // Same reason: a message copied while streaming has nothing left to
        // stream into it, so it would render with a caret that never resolves.
        overrides: { is_streaming: 0 },
      }),
    );
    const activities = record(
      copyRows({
        source,
        target,
        table: "projection_thread_activities",
        keyColumn: "thread_id",
        keys: threadIds,
        perKeyLimit: { orderBy: "created_at", limit: options.activityLimit },
      }),
    );
    const sessions = record(
      copyRows({
        source,
        target,
        table: "projection_thread_sessions",
        keyColumn: "thread_id",
        keys: threadIds,
        // No agent process is attached in the copy. A carried-over "running"
        // status with an active turn renders a thread that spins forever, and
        // ProviderSessionReaper skips reaping anything with an active turn.
        overrides: { status: "stopped", active_turn_id: null, last_error: null },
      }),
    );
    record(
      copyRows({
        source,
        target,
        table: "projection_thread_proposed_plans",
        keyColumn: "thread_id",
        keys: threadIds,
      }),
    );
    // projection_pending_approvals is deliberately skipped: migration 025 deletes
    // approvals with no matching `approval.requested` activity, and the activity
    // cap above can easily drop it.

    // Required: computeSnapshotSequence returns 0 unless every projector has a
    // row, which makes every shell snapshot advertise sequence 0.
    //
    // Zero, not the source's cursors. `orchestration_events.sequence` is
    // AUTOINCREMENT, so emptying the log does not reset its high-water mark and
    // the next real event continues from wherever the target left off. A cursor
    // carried over from the source is unrelated to that number: it could sit
    // above it (each projector then silently skipping a different count of the
    // user's first real events, desynchronizing the projections for good) or
    // below it (replaying events over rows they never produced). Zero is below
    // every future sequence, so bootstrap streams the empty log, finds nothing,
    // and leaves the copied rows exactly as they are.
    const insertState = target.prepare(
      `INSERT OR REPLACE INTO projection_state (projector, last_applied_sequence, updated_at)
       VALUES (?, 0, ?)`,
    );
    for (const projector of PROJECTOR_NAMES) {
      insertState.run(projector, options.seededAt);
    }

    // Read back inside the transaction: these are the rows that were just
    // written, not the source's, so a column the target lacks is already gone.
    const attachmentIds = collectAttachmentIds(target, threadIds);

    target.exec("COMMIT");

    return {
      projects,
      threads,
      messages,
      activities,
      turns,
      sessions,
      skippedColumns: [...new Set(skipped)].sort(),
      attachmentIds,
    };
  } catch (cause) {
    try {
      target.exec("ROLLBACK");
    } catch {
      // Already rolled back, or the transaction never opened.
    }
    throw cause instanceof DevSeedError
      ? cause
      : new DevSeedError(`could not seed the dev database: ${String(cause)}`);
  } finally {
    source.close();
    target.close();
  }
}
