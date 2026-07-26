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
   (`adapter.py:207-209`, `:254-256`).
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

`T3PlatformAdapter.send(chat_id, content, metadata)` grows a proactive branch: when
there is **no active turn** for the target and `chat_id` equals the home thread id,
emit `home.deliver` instead of failing with `"no active T3 turn"`. Kind/label
classification is best-effort from what Hermes passes in `metadata` and the send
context (cron deliveries are identifiable; gateway startup/shutdown broadcasts match
known message shapes; everything else defaults to `kind: "message"`, label "Hermes").
Sends to a non-home thread without an active turn keep the current explicit error —
scope creep into "message any thread unprompted" is deliberately excluded.

The `/sethome` nudge suppression (`adapter.py:41-46`, `:211-214`, `:258-259`) stays:
once `env_enablement_fn` seeds a home channel Hermes stops emitting the nudge
naturally, but the suppression covers the pre-designation window (first connect before
any `connection.accepted` has written the env var).

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
