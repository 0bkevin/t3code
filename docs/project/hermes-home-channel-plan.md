# Hermes home channel: a designated thread for proactive delivery

## Context

Hermes has a first-class "home channel" concept: a per-platform default destination
where proactive output lands when no specific destination was named — cron job results
(`deliver=<platform>`), the agent's `send_message` tool with a bare platform target,
gateway online/shutdown notices, and `/handoff` targets. It is core gateway machinery
(`gateway/config.py` `HomeChannel`, `/sethome`, `get_home_channel()`), not a Discord
feature — the Discord plugin contributes only registration flags, an env var, and a
setup prompt; delivery goes through the ordinary `adapter.send(chat_id, ...)`.

The T3 gateway plugin currently opts out. It suppresses Hermes' "No home channel is
set… Type /sethome" nudge by exact string match (`adapter.py:41-46`, dropped at
`:211-214` and `:258-259`) **without designating a home channel**. Consequences today:

- A cron job created in a T3 Hermes thread with `deliver=t3` silently goes nowhere.
- Hermes' agent cannot proactively reach the user through T3 (`send_message` with a
  bare `t3` target errors: no home channel).
- `/handoff t3` from any other surface (CLI, TUI, Discord) hard-errors.

Three independent gates block Hermes-initiated messages into T3:

1. **Plugin turn gate** — every emitter requires `_active_turns[thread_id]`, populated
   only by a T3-issued `turn.start`; `send()` fails with `"no active T3 turn"`
   (`adapter.py:209`, `:256`). Since the finalize-bug fixes (`3f71c601a`), turn
   completion is keyed **exclusively** off `notify=True` metadata on `send()`
   (`adapter.py:212-217`); `finalize` on `edit_message` is ignored outright. Any
   proactive branch added to `send()` must respect that contract — see Part 3.
2. **Contract gate** — no plugin→T3 frame in protocol v2 opens a session or turn
   (`packages/contracts/src/hermesGateway.ts:672-694`); everything is a reply carrying
   a T3-minted `requestId`.
3. **Server gates** — `HermesAdapter.toRuntimeEvent` drops frames for unknown
   threads/sessions (`HermesAdapter.ts:251-262`), and `ProviderRuntimeIngestion` bails
   on unknown threads and non-active turns (`ProviderRuntimeIngestion.ts:1349-1350`,
   `:1370-1411`).

Intended outcome: every enrolled Hermes instance gets one **Home** thread — pinned
first in its agent project — that receives all of Hermes' proactive delivery, is fully
conversational, survives restarts, and raises its hand (inbox + mobile push) when
something worth seeing arrives.

---

## Decisions locked with the user

| Question            | Decision                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Placement           | One special thread **inside the existing per-instance agent project** (`agents/<instanceId>`)                    |
| What routes there   | **Everything**: cron/routine output, agent `send_message` to bare `t3`, gateway lifecycle notices, `/handoff t3` |
| Designation         | **Auto on enrollment/first connect**, converge-on-read like agent projects — zero setup                          |
| Re-homing           | **Fixed, not movable.** `/sethome` nudge suppression stays; there is nothing to set                              |
| Interactivity       | **Fully conversational** — replying runs a normal Hermes turn in the same thread                                 |
| Protocol            | **Bump to v3** with new plugin→T3 frames; v2's fail-closed version policy is kept                                |
| Rendering           | **Labeled notification turns** — assistant messages carrying source metadata rendered as a badge/header          |
| Offline delivery    | **Durable plugin-side queue**, flushed on reconnect; nothing lost across either side restarting                  |
| Attention           | **Unsettle + mobile push for everything except lifecycle notices**, which land quietly (unread only)             |
| Out-of-process cron | **Full support**: `cron_deliver_env_var` + a standalone sender that dials T3 over a short-lived WS               |
| UI                  | **Pinned "Home" at the top** of the instance's thread list — plain name, no emoji; undeletable; unread badge     |

---

## Part 1 — Protocol v3

Bump `PROTOCOL_VERSION` to 3 on both sides (`protocol.py:10`,
`packages/contracts/src/hermesGateway.ts:24`). Mismatch continues to fail the
handshake closed — server and plugin update together, per existing policy.

### New frames

**T3 → plugin** — extend `connection.accepted` with:

- `homeThreadId: ThreadId` — the durable home thread for this instance. Sent on every
  successful handshake so the plugin can reconcile local state each connect.

**Plugin → T3:**

- `home.deliver` — Hermes-initiated delivery into the home thread:
  - `deliveryId: string` — plugin-minted, unique, stable across retries (idempotency key)
  - `kind: "cron" | "message" | "lifecycle" | "handoff" | "other"`
  - `label: string` — human source label ("Cron: daily-digest", "Gateway online", …)
  - `text: string` — the delivered content (markdown)
  - `createdAt: string` — ISO timestamp captured when Hermes produced it (matters for
    queued deliveries flushed later)

**T3 → plugin:**

- `home.deliver.ack` — `{ deliveryId }`. The plugin purges a queued delivery only on
  ack; unacked deliveries are retried on the next (re)connect. T3 dedupes on
  `deliveryId` so retries are safe.

### Connection roles (the broker-replacement problem)

`HermesGatewayBroker.registerConnection` **replaces** the live connection under
generation fencing ("The Hermes gateway connection was replaced by a newer
connection", `HermesGatewayBroker.ts:982`). An out-of-process cron sender dialing in
naively would kick the live gateway socket off.

Fix at the handshake: `connection.hello` gains `role: "gateway" | "delivery"`
(decoding default `"gateway"` so the field is honest about intent, though v3 requires
both sides updated anyway). The broker handles `role: "delivery"` connections
separately: authenticated the same way, **never** registered as the instance's primary
connection, no generation bump, no liveness pinger — accepted, allowed to send
`home.deliver` frames and receive acks, and expected to close promptly. The
existing primary connection is untouched.

---

## Part 2 — T3 server: durable designation + ingestion

### `getOrCreateHomeThread(instanceId)`

Copy the `getOrCreateAgentProject` converge-on-read pattern verbatim
(`apps/server/src/orchestration/agentProjects.ts:73-147`) — a precondition every
caller runs, not an event one caller owns:

1. Read the designation from the instance's settings config blob:
   `homeThreadId` alongside the existing `connectorUrl` / `revoked` fields
   (`HermesGatewayBroker.ts:144-149`, written via `withHermesConfig` `:244-270`).
   Settings, not a new table/column — the designation is per-instance instance
   metadata, exactly like enrollment facts, and this avoids a migration.
2. If set and the thread still exists (not deleted), return it.
3. Otherwise: `getOrCreateAgentProject(instanceId)` first, then dispatch
   `thread.create` into that project with `title: "Home"` (server-minted threads have
   precedent: `ws.ts:996`, `serverRuntimeStartup.ts:225`), persist `homeThreadId`,
   return it. Same lost-race handling: on dispatch failure, re-read before erroring.

Callers: the connection handshake path (every `connection.hello` for an enrolled
instance resolves it before sending `connection.accepted` with `homeThreadId`), and
`home.deliver` ingestion as a belt-and-braces re-check.

The home thread is **undeletable**: the decider rejects `thread.delete` for a thread
whose id matches its instance's `homeThreadId`. Fixed designation means this check has
a single durable source of truth.

### Ingesting `home.deliver`

Deliveries deliberately bypass the provider turn machinery — there is no provider
session or turn; a delivery may arrive while the home thread has an active user turn
and must not conflict with it (the turn-conflict gate at
`ProviderRuntimeIngestion.ts:1370-1411` stays untouched).

- New orchestration command/event pair, e.g. `thread.notification-delivered`, carrying
  `{ threadId, deliveryId, kind, label, text, createdAt }`.
- Decider: dedupe on `deliveryId` (idempotent replays from the plugin queue), append a
  message row flagged as a notification (`kind` + `label` stored in message metadata),
  and — for every kind except `lifecycle` — un-settle / un-snooze the thread via the
  existing server-decided `reason: "activity"` path (`orchestration.ts:606-612`,
  `:1027-1032`). Lifecycle notices append quietly (unread indicator only).
- Broker: on receiving `home.deliver` (from either connection role), dispatch the
  command; on successful dispatch, reply `home.deliver.ack`. Ack after durable write,
  never before — the plugin queue's correctness depends on it.

### Attention / push

`shouldPublishAgentAwarenessEvent` (`apps/server/src/relay/AgentAwarenessRelay.ts:67+`)
accepts the new event when `kind !== "lifecycle"`. Phase/headline mapping in
`packages/shared/src/agentAwareness.ts` gains a notification case (headline from
`label`). Existing mobile push registration and deep-link plumbing is reused as-is.

---

## Part 3 — Hermes plugin: registering real home-channel support

Hermes core needs three things from the plugin for full routing (per the platform
contract in `website/docs/developer-guide/adding-platform-adapters.md:205-330`):

1. **`cron_deliver_env_var="T3_HOME_CHANNEL"`** on `ctx.register_platform`
   (`__init__.py:44-63`). The name follows Hermes' `_home_target_env_var` fallback
   convention (`f"{PLATFORM.upper()}_HOME_CHANNEL"` for platform `t3`), so the
   `send_message` error hints and cron env resolution work without an override entry.
   Without this, `deliver=t3` is silently dropped by cron.
2. **`env_enablement_fn` seeds `home_channel`** — extend the existing
   `env_enablement` to add `seed["home_channel"] = {"chat_id": <thread id>, "name":
"Home"}` from `T3_HOME_CHANNEL` (pattern: `plugins/platforms/irc/adapter.py:648-701`).
   This is what makes `get_home_channel(t3)` resolve for `send_message`, lifecycle
   broadcasts, and `/handoff` — core only hardcodes env promotion for built-ins.
3. **`standalone_sender_fn`** — async fn for out-of-process cron (signature per
   `gateway/platform_registry.py:154-160`). Implementation: open a short-lived WS to
   the stored gateway URL, `connection.hello` with `role: "delivery"` and the stored
   credential, wait for `connection.accepted`, send `home.deliver`, wait for the ack,
   close. Returns `{"success": True, "message_id": deliveryId}` or `{"error": ...}`.
   On connection failure it appends to the durable queue (below) and reports success
   -with-queued rather than failing the cron job.

### Reconciling `T3_HOME_CHANNEL` automatically

The env var is written by the **plugin**, not the user: on every `connection.accepted`
carrying `homeThreadId`, the plugin compares and persists via Hermes'
`save_env_value("T3_HOME_CHANNEL", ...)` (the same profile-aware helper enrollment
already uses for `HERMES_T3_GATEWAY_*`). Auto-designation stays zero-setup, and cron's
env-only resolution path is always in sync with T3's durable designation.

### Adapter delivery path

`T3PlatformAdapter.send(chat_id, content, metadata)` grows a proactive branch for the
home thread. **The gate must be provenance, not merely turn absence.** The naive rule
("no active turn for this thread → `home.deliver`") deadlocks against the
notify-completion contract when the home thread itself has a live turn: a cron or
`send_message` delivery targeting the home chat while the user is mid-conversation
there would fall into the active-turn path, be streamed as that turn's assistant
content, and — because final cron deliveries arrive notify-stamped — **complete the
user's live turn with the cron output as its answer**. That is the same
keyed-off-the-wrong-signal defect class COMPATIBILITY.md documents for `finalize`.

The discriminator already exists: `_gateway_session_key()` (`adapter.py`, added in
`3f71c601a`) reads `HERMES_SESSION_KEY` from Hermes' session contextvar. A genuine
turn reply is produced inside the turn's session context, so the key resolves to this
plugin's `build_session_key` id for that thread; cron deliveries run in their own
`cron_*` session and broadcasts run in none, so the key is absent or names a different
session. The branch rule in `send()` is therefore:

- Active turn for `chat_id` **and** session key matches that turn's session → normal
  turn path (`_emit_assistant_content`, `notify` completes the turn).
- `chat_id` is the home thread and the session key does **not** match an active turn
  there (or no turn exists) → emit `home.deliver`. Never touch `_active_turns`.
- Non-home thread without a matching active turn → keep the current explicit
  `"no active T3 turn"` error; "message any thread unprompted" stays out of scope.

Kind/label classification is best-effort from `metadata` and the send context (cron
deliveries are identifiable; gateway startup/shutdown broadcasts match known message
shapes; everything else defaults to `kind: "message"`, label "Hermes").

Three constraints from the turn-lifecycle fixes (`3f71c601a`, `a4000b86d`,
COMPATIBILITY.md "Turn completion is keyed off `notify`, never `finalize`") shape
this branch:

- **Ordering inside `send()`.** The steer-control capture
  (`_capture_steer_control_response`, `adapter.py:205`) must stay first — steer
  acknowledgements arrive with `notify=True` and must never be misread as proactive
  deliveries. The proactive branch slots after capture, gated by the provenance rule
  above.
- **`notify` does not end anything here.** In the active-turn path `notify=True`
  triggers `_complete_turn`; in the proactive branch there is no turn to complete —
  the metadata is consumed only as a classification hint (final cron deliveries
  arrive notify-stamped via `_mark_notify_metadata`, `gateway/platforms/base.py:89`).
  The branch must not touch `_active_turns` or emit any turn/item frames — only
  `home.deliver`.
- **Proactive edits are not supported.** Hermes' progress loop may follow a `send`
  with `edit_message` calls against the returned `message_id` (the tool-progress
  bubble pattern). `edit_message` outside an active turn keeps returning
  `"no active T3 turn"` — a delivery is an atomic document, not a streaming surface.
  In practice cron/`send_message`/lifecycle deliveries are single sends; if an
  upstream path ever streams a home delivery, revisit with a
  `home.deliver`-supersedes-by-`deliveryId` scheme rather than edit frames.

The `/sethome` nudge suppression (`adapter.py:41-46`; checks at `:211`, `:258`)
stays: once `env_enablement_fn` seeds a home channel Hermes stops emitting the nudge
naturally, but the suppression covers the pre-designation window (first connect before
any `connection.accepted` has written the env var). Note the nudge check now also
gates on `notify` for turn completion (`adapter.py:211-214`) — the suppression tests
in `tests/test_adapter.py` pin this and must keep passing.

### Durable plugin-side queue

A small JSONL queue file in the plugin's state area (same directory family as its
other persisted state; entries are `home.deliver` payloads). Append on any failed or
disconnected delivery; flush FIFO after each `connection.accepted`; delete an entry
only on its `home.deliver.ack`. T3-side `deliveryId` dedupe makes double-flush safe.
Cap the queue (e.g. a few hundred entries / a size bound) and drop-oldest with a
logged warning rather than growing without bound.

**COMPATIBILITY.md must be updated** with any new upstream Hermes surfaces this
touches (`save_env_value` from the enrollment path is already audited; queue/state
location and any metadata fields read for classification are new entries).

---

## Part 4 — Web UI

- **Pinned Home thread.** In the instance's thread list on the Agent page
  (`apps/web/src/components/agents/AgentPage.tsx`) and the Agents sidebar section
  (`Sidebar.logic.ts:855-970`), the home thread sorts first with a distinct row
  treatment. Plain title "Home" — no emoji. The web client learns which thread is home
  from the provider snapshot: surface `homeThreadId` on the Hermes instance's
  `ServerProvider` snapshot (it is already assembled from the same settings blob).
- **Notification rendering.** Message rows whose metadata carries `kind`/`label`
  render a small header badge above the content (e.g. "Cron · daily-digest",
  "Gateway"). Lifecycle notices use the muted treatment. Everything else about the row
  is a normal assistant message — selectable, copyable, part of the transcript.
- **Unread/inbox.** No new mechanism: notification events un-settle the thread through
  the standard decider path, so existing unread indicators, inbox surfacing, and
  snooze-wake behavior apply unchanged.
- **Undeletable.** Thread action menus hide/disable Delete for the home thread
  (server-side decider rejection is the real guard; UI just avoids offering it).
- Composer in the home thread is the normal Hermes composer — replying starts an
  ordinary `session.ensure`/`turn.start` flow on the same `threadId`.
- **Pinning must survive the sidebar dedupe.** `visibleSidebarSections` now
  de-duplicates by `projectKey` (`Sidebar.tsx:3555+`, added in `3f71c601a`'s batch)
  and `getSidebarThreadIdsToPrewarm` dedupes thread ids. Home-thread pinning is a
  sort inside one section's thread list, so it composes with both — but the pinned
  ordering must be applied before the prewarm slice so Home is always warm.

---

## Part 5 — Bundled fix: settled-turn activity escapes the "Worked for …" fold

Not home-channel machinery, but it lands in the same surfaces (Hermes activity
ordering in the timeline) and the home thread will render notification + turn
activity constantly, so it ships with this work.

**Symptom.** After a Hermes turn settles, its activity should collapse behind the
"Worked for …" fold above the final answer. Instead the activity splits: one cluster
(work summary) folds correctly above, and a second cluster (the steps taken /
"Work Log" with rows like "Hermes activity is running …") renders **below** the final
assistant message, outside the fold. Both belong above.

**What's already fixed.** `a4000b86d` reordered `_complete_turn` to close the live
status item before the assistant message, because T3's fold only captures entries
preceding the turn's terminal message — the status item was being stamped ~2ms after
the answer and escaping. That fix is correct but insufficient: the symptom still
reproduces (observed post-fix with a "Work Log — Hermes activity" section below the
answer), which means at least one more path produces late- or mis-attributed entries.

**How the fold actually works** (`MessagesTimeline.logic.ts`):

- `deriveTimelineEntries` (`session-logic.ts:1340-1366`) merges messages, plans, and
  work entries and sorts **purely by `createdAt` string compare**. Assistant messages
  sort at their _creation_ time (early in the turn); activities re-stamp `createdAt`
  on every update (the projector replaces by id and re-sorts,
  `projector.ts:725-753`), so a turn's activities always sort _after_ its assistant
  message. Position alone is therefore expected to be "activities below".
- The fold compensates: `deriveTurnFolds` (`MessagesTimeline.logic.ts:285-404`)
  groups entries by `turnId` and hides **every non-terminal entry of a settled turn
  regardless of timestamp position**. So a trailing activity row that carries the
  right `turnId` cannot escape the fold.
- Consequently, an entry rendering below the final message **must have failed turn
  attribution** — grouping skips entries whose `turnId` resolves null
  (`MessagesTimeline.logic.ts:311-318`), and unattributed entries can never be hidden.

**Candidate mechanisms to run down, in likelihood order:**

1. **Late frames lose their turn.** Plugin tool hooks run on Hermes tool worker
   threads; a `post_tool_call` → `item.completed` frame can arrive after
   `turn.completed`. `ProviderRuntimeIngestion`'s turn-conflict gate
   (`ProviderRuntimeIngestion.ts:1370-1411`) rejects events naming a non-active turn
   — but any acceptance path that strips or nulls `turnId` (or an ingestion branch
   that emits the activity with `toTurnId(...) ?? null`) produces exactly this
   symptom. Check what happens to an `item.*` frame for a just-completed turn.
2. **Command-dispatch race.** Activity appends and message finalization are separate
   orchestration commands; wire order (status completed before assistant, per
   `a4000b86d`) does not guarantee commit order. If the activity append commits after
   the turn record settles, does any code path re-key or drop its `turnId`?
3. **Fallback attribution gap.** `_turn_for_tool_hook`'s sole-active-turn fallback
   emits nothing when it cannot resolve — but the _generic status_ item
   (`_ensure_generic_activity`) and any frames emitted between `notify` completion
   and socket flush should be audited for a window where `turn.turn_id` is stale or
   the frame is built without it.

The decisive experiment: reproduce, then inspect the projected thread — the escaping
activity row's `turnId` in `projection_thread_activities`. Null confirms attribution
loss (mechanisms 1/3); a correct `turnId` with the row still visible would falsify
the fold analysis and point back at web-side grouping.

**Fix direction.** Two layers, both worth doing:

- Root cause: guarantee `turnId` attribution end-to-end for every activity a turn
  produces, including frames that land after `turn.completed` (accept-and-attribute
  late items for a recently-completed turn rather than dropping/nulling).
- Defense: the fold should not depend on perfect attribution. For a settled turn,
  any work entry timestamped between the turn's first entry and its terminal
  message's `updatedAt` (plus a small trailing grace window) with no other turn
  claiming it belongs to that turn's fold. This also future-proofs the home thread,
  where notification rows and turn activity will interleave.

Regression test: replay the recorded frame sequence of a real Hermes turn (the
existing `test_adapter.py` frame-replay pattern) plus a late `item.completed`, and
assert the derived timeline rows place no work/activity row after the terminal
assistant message of a settled turn.

---

## Sequencing

Each step typechecks and is testable on its own:

1. **Contract + protocol v3** — new frames, `homeThreadId` on `connection.accepted`,
   `role` on `connection.hello`, version bump both sides. Plugin accepts and ignores
   deliveries it can't yet produce; server accepts and acks nothing yet.
2. **Server designation** — settings-blob `homeThreadId`, `getOrCreateHomeThread`,
   handshake integration, undeletable guard.
3. **Server ingestion** — `thread.notification-delivered` command/event, dedupe,
   activity un-settle, ack wiring, broker `role: "delivery"` handling.
4. **Plugin delivery** — registration flags (`cron_deliver_env_var`,
   `env_enablement_fn` home seed), env-var reconciliation, proactive `send()` branch,
   durable queue.
5. **Standalone sender** — short-lived delivery connection for out-of-process cron.
6. **Web UI** — snapshot `homeThreadId`, pinned row, notification badges, delete
   suppression.
7. **Push** — `AgentAwarenessRelay` acceptance + headline mapping.
8. **Fold-escape fix (Part 5)** — independent of 1–7; can land first. Doing it
   before the home-channel UI keeps notification rows from inheriting the same
   mis-ordering.

Steps 1–3 make T3 able to receive; step 4 makes the flagship flows (cron via live
gateway, `send_message`, lifecycle, `/handoff`) work end to end; 5–7 complete it.

---

## Verification

Dev setup per the previous plan: dev-runner against an isolated base dir with the live
`hermes-gateway.service` connection; Hermes CLI reads need
`/home/davis/.hermes/hermes-agent/venv/bin/python` with
`PYTHONPATH=/home/davis/.hermes/hermes-agent` (system `python3` lacks `websockets`).
Bind the dev server to `0.0.0.0` and use `http://siva.davis7.space:<port>/`.

Manual checks:

1. Enroll (or reconnect) an instance → a "Home" thread exists in its agent project,
   pinned first, undeletable; `hermes t3 status` area / env shows `T3_HOME_CHANNEL`
   set to the thread id.
2. In any Hermes T3 thread: create a cron job with `deliver=t3` firing in a minute →
   result lands in Home as a labeled "Cron" turn; thread un-settles; mobile push fires.
3. Ask Hermes (from Discord or CLI) to `send_message` to `t3` → lands in Home.
4. `hermes gateway restart` → "Gateway online" appears in Home **quietly**: unread
   badge, no push, muted rendering.
5. `/handoff t3` from the Hermes CLI → conversation continues in/under Home.
6. Stop the T3 server, fire a `deliver=t3` cron job, restart T3 → the queued delivery
   flushes exactly once (check `deliveryId` dedupe by also restarting the plugin).
7. Reply inside Home → a normal Hermes turn runs and streams in the same thread; an
   incoming delivery during that turn appends without disturbing the active turn.
8. Out-of-process cron path (gateway process stopped, cron firing standalone) →
   delivery arrives via a `role: "delivery"` connection **without** kicking or
   generation-bumping a live gateway socket (verify with a concurrent live connection).
9. Regression: Claude/Codex threads and non-home Hermes threads unchanged; unsolicited
   sends to non-home threads still error.
10. Turn/delivery interleave in Home: while a user turn is running in the home
    thread, fire a `deliver=t3` cron job → the delivery lands as a notification row
    and the live turn keeps streaming and completes normally on its own `notify`
    (this is the provenance-gate check from Part 3 — the failure mode is the cron
    output completing the user's turn).
11. Part 5: settle a Hermes turn that used tools → all activity, including the
    status line and every tool row, folds behind "Worked for …"; nothing renders
    between or below the final answer.

Automated: `pnpm typecheck`, `pnpm test`, `pnpm lint`; plugin tests in
`integrations/hermes-t3-gateway/tests` (queue FIFO + ack purge, nudge suppression
still pinned, proactive-send branch, standalone sender against a mock server);
`.logic.test.ts` files for any new web logic per convention.

## Open risks

- **Kind/label classification is heuristic.** Hermes' `adapter.send()` contract
  doesn't carry a structured "this is a cron delivery" marker in every path; matching
  on metadata/message shape may misclassify some deliveries as generic `message`.
  Worst case is a wrong badge, not a lost delivery. If upstream Hermes ever exposes
  delivery provenance in metadata, adopt it and note it in COMPATIBILITY.md.
- **Two sources of designation truth.** T3's settings blob is authoritative;
  `T3_HOME_CHANNEL` on the Hermes side is a synced cache. The reconcile-on-every-
  `connection.accepted` rule bounds drift to one reconnect, but a hand-edited env var
  will be overwritten — document this in the plugin README.
- **Lifecycle notice volume.** Frequent gateway restarts write quiet rows into Home.
  If that proves noisy, Hermes' per-platform `gateway_restart_notification: false`
  opt-out is the escape hatch (a one-line config change, no code).
- **The sole-active-turn tool-hook fallback misattributes cron tool activity.**
  `_turn_for_tool_hook` (added in `3f71c601a`) falls back to "the sole active turn"
  when no routing key resolves. The plugin's `pre/post_tool_call` hooks are
  process-global, so a **cron job running tools** while exactly one T3 turn is
  active resolves through that fallback and paints the cron job's tool calls into
  the unrelated live turn. Upstream is aware of the general hazard (the cron
  scheduler deliberately avoids the process-global env var for exactly this
  routing risk, `cron/scheduler.py:3077`). Low-frequency today; this feature makes
  `deliver=t3` cron jobs common, so fix alongside Part 3: before the sole-turn
  fallback, exclude hook calls whose `session_id` is a cron run id (`cron_*`
  prefix, `cron/scheduler.py:3017`) — their activity belongs to the eventual
  `home.deliver`, not to any live turn.
