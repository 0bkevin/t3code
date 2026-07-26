# Hermes agent UX: directoryless threads + a generic Agent page

## Context

The Hermes provider integration now functions end to end, but the UI around it still
assumes every thread is a coding task rooted in a git checkout. Three things are wrong
today, all visible in a fresh Hermes thread:

1. **Directory UI that means nothing.** A Hermes thread shows a project breadcrumb,
   "What should we build in _server_?", a "Current checkout" picker, a branch selector,
   and Open / Create PR buttons. You are not working in a directory when you talk to a
   Hermes agent — you are talking to an agent that has its own machine and its own tools.
2. **A permissions control that lies.** The runtime-mode selector ("Supervised /
   Auto-accept edits / Auto / Full access") renders unconditionally for every provider,
   but T3 does not pass those modes through to Hermes. The control implies a guarantee
   that nothing enforces.
3. **No way to see what the agent actually is.** There is no surface anywhere showing an
   agent's skills, connected MCP servers, model, or reasoning effort. The composer's
   Build toggle is dead weight for Hermes (it declares
   `showInteractionModeToggle: false`), so its slot is free.

Intended outcome: a Hermes thread reads as _a conversation with an agent_, not a
misconfigured coding task; and a new **Agent page** — generic across providers, not
Hermes-specific — becomes the place to inspect any agent's status, model, effort, skills,
and (later) MCP servers.

---

## Decisions locked with the user

| Question                               | Decision                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Where Hermes threads live              | Top-level **Agents** sidebar section                                                                    |
| How they satisfy `project_id NOT NULL` | **Synthetic agent project** auto-created per instance — no migration of the required column             |
| Synthetic `workspaceRoot`              | A **real directory** under T3 home: `<t3home>/agents/<instanceId>/`                                     |
| Thread header actions                  | Hide Open / Create PR / branch / checkout; **add a Hermes status affordance** linking to the Agent page |
| Empty-state headline                   | **"What's on your mind?"**                                                                              |
| Mechanism                              | **General capability flag**, not a `driverKind === "hermes"` branch                                     |
| Agent page route                       | Top-level **`/agents/$instanceId`**                                                                     |
| Page data                              | **New generic describe RPC per driver** (live query)                                                    |
| Composer button                        | **Hermes-only button now, provider-generic page**                                                       |
| Page actions                           | Refresh, reconnect, jump to settings, start a thread — **all four**                                     |
| Skills                                 | Metadata list; **fetch body on click**, never eager-load bodies                                         |
| MCP servers                            | **Deferred to v2** (does not exist at any layer today)                                                  |

---

## Part 1 — `requiresWorkspace` capability

The codebase has **no per-driver capability record**. Two per-instance flags exist on
`ServerProvider` (`packages/contracts/src/server.ts:168-169`):
`showInteractionModeToggle`, `requiresNewThreadForModelChange`. Add a third alongside
them rather than inventing a parallel mechanism.

**Contract** — `packages/contracts/src/server.ts`, on `ServerProvider`:

- `requiresWorkspace?: Boolean` — decoding default `true` so every existing provider and
  cached snapshot keeps today's behavior.

**Server** — each driver's `ServerProviderPresentation`
(`apps/server/src/provider/providerSnapshot.ts:55-60`):

- `apps/server/src/provider/Drivers/HermesDriver.ts:80-81` → `requiresWorkspace: false`,
  next to its existing `showInteractionModeToggle: false`.
- Every other driver inherits `true` from the decoding default — no edits needed.

**Web accessor** — `apps/web/src/providerModels.ts`, mirroring
`getProviderInteractionModeToggle:49-54`:

```ts
export function getProviderRequiresWorkspace(/* …same shape… */): boolean;
```

Default `true` on any missing/unknown snapshot, matching the module's
unknown-driver-must-not-crash invariant (`providerInstance.ts:16-35`).

### Also gate the runtime-mode selector (item 2)

The runtime-mode `Select` currently has **no capability gate at all** — it renders
unconditionally at `ChatComposer.tsx:323+` and `CompactComposerControlsMenu.tsx:65-76`.
Rather than a second flag, gate it on the same `requiresWorkspace` value: the
Supervised/Full-access distinction is exactly about filesystem and command access, so a
provider with no workspace has nothing to scope. Thread the boolean through
`ComposerFooterModeControls` (`ChatComposer.tsx:267-320`) as
`showRuntimeModeSelector`, and through `CompactComposerControlsMenu` for the narrow
layout — both call sites must be updated or the control survives on mobile widths.

---

## Part 2 — Synthetic agent projects

`OrchestrationThread.projectId` is required (`orchestration.ts:345-378`) and
`projection_threads.project_id` is `NOT NULL`
(`apps/server/src/persistence/Migrations/005_Projections.ts:23`). A synthetic project
satisfies both without touching either.

`OrchestrationProject` (`orchestration.ts:212-222`) needs only `title` +
`workspaceRoot` as non-empty strings, so an agent project is a legal project row.

**New migration** — additive columns only, no `NOT NULL` change:

- `projection_projects.agent_instance_id TEXT` (nullable) — set for agent projects,
  `NULL` for every real project. Index it.
- Contract: `OrchestrationProject.agentInstanceId?: NullOr(ProviderInstanceId)` with a
  decoding default of `null`.

**Lifecycle** — _superseded during implementation._ See "Agent projects are
converge-on-read" below; the enrollment/removal hooks described here were replaced by
a single idempotent `getOrCreateAgentProject` precondition. Original design:

Hook the existing Hermes enrollment path in
`apps/server/src/provider/Layers/HermesGatewayBroker.ts` (durable `InstanceRecord`
at `:144-148`, persisted via `readHermesConfig` at `:222-232`):

- On instance enrollment: `mkdir -p <t3home>/agents/<instanceId>/`, then emit
  `project.create` (`orchestration.ts:516`) with
  `createWorkspaceRootIfMissing: true`, `title` = instance nickname,
  `agentInstanceId` = the instance id.
- On instance removal: soft-delete the project (`deletedAt`), leaving threads readable.
  Do **not** delete the directory implicitly — a stale empty dir is cheaper than
  destroying anything a user put there.

**Guard:** agent projects must be excluded from every "pick a project" surface — the
`DraftHeroHeadline` project menu (`:117-119`), the sidebar Projects section, and
`buildSidebarProjectPickerEntries`. Filter on `agentInstanceId !== null` in
`apps/web/src/sidebarProjectGrouping.ts` and the picker builders. A single missed filter
is the most likely bug in this part.

---

## Part 3 — Hiding directory UI

The master seam already exists: **`showComposerContextStrip`** at
`apps/web/src/components/ChatView.tsx:2380`
(`isGitRepo && activeProject !== null`) gates the entire BranchToolbar row (`:5869`)
and its glass shell (`:5780`). Extend it with `&& providerRequiresWorkspace`.

Per surface:

| Surface                             | File                                                             | Change                                                                          |
| ----------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Branch toolbar / "Current checkout" | `ChatView.tsx:5869`, `BranchToolbar.tsx`                         | Covered by extending `showComposerContextStrip`                                 |
| Breadcrumb project chunk            | `ChatHeader.tsx:93-122`                                          | Already conditional on `activeProjectName`; pass it as `null` for agent threads |
| Open in editor                      | `ChatHeader.tsx:46-56` (`shouldShowOpenInPicker`)                | Add `requiresWorkspace` to the predicate                                        |
| Create PR / git actions             | `ChatHeader.tsx:151`                                             | Same                                                                            |
| Draft headline                      | `DraftHeroHeadline.tsx:147-157`                                  | New branch → "What's on your mind?"; suppress the project picker                |
| Runtime mode selector               | `ChatComposer.tsx:323+`, `CompactComposerControlsMenu.tsx:65-76` | Gate per Part 1                                                                 |

`ChatHeader` and `DraftHeroHeadline` already have no-project fallback branches
(`:93`, `:143`, `:151` and `:151-155` respectively), so this is mostly _reaching_ those
branches, not writing new ones.

**Header status affordance:** in the slot vacated by Open/Create PR, render a compact
Hermes status control — connection badge + model — linking to `/agents/$instanceId`.
Reuse `PROVIDER_STATUS_STYLES` (`apps/web/src/components/settings/providerStatus.ts:7-20`)
for the dot and the `Badge` variant map at `HermesGatewayInstanceSection.tsx:37-46`.

---

## Part 4 — The describe RPC

**Contract** — `packages/contracts/src/provider.ts` + a new method in
`packages/contracts/src/rpc.ts` (`WS_METHODS`, near `serverRefreshProviders:224`):

- `provider.describeInstance` → input `{ instanceId }`, result `ProviderInstanceDescription`:
  - `identity`: nickname, driverKind, versions (agent, plugin, protocol), host, uptime
  - `connection`: status, lastConnectedAt, activeSessionCount, connectionGeneration
  - `model`: current model id + display name, provider behind it, context window
  - `reasoningEffort`: **resolved label, not a raw field.** Effort is not first-class —
    it is a provider-declared option descriptor whose `id` differs per driver
    (`reasoningEffort` for Codex, `reasoning` for Cursor, prompt-injected for Claude).
    Resolve server-side with `getProviderOptionCurrentLabel`
    (`packages/shared/src/model.ts:176`) and send the human label.
  - `skills`: `ReadonlyArray<ServerProviderSkill>` — **metadata only, no bodies**
  - `capabilities`: the reported capability struct (already stored for Hermes at
    `HermesGatewayInstanceStatus.capabilities`, currently rendered nowhere)
  - `mcpServers`: **omit in v1**; add the field when v2 lands so the shape doesn't churn
- `provider.getSkillBody` → input `{ instanceId, skillName }`, result `{ markdown }`.
  Separate call, fired on row expand.

**Driver dispatch** — a `describe` method on `ProviderAdapter`
(`apps/server/src/provider/Services/ProviderAdapter.ts:26-33`, where
`ProviderAdapterCapabilities` already lives), with a default implementation that
projects whatever is already on the `ServerProvider` snapshot. That default alone gives
Claude and Codex a working page for free — both already report `skills`
(`ClaudeSkills.ts:93` filesystem scan; `CodexProvider.ts:394-396` `skills/list` RPC) and
option descriptors. Only Hermes needs a real override.

**Hermes plugin** — `integrations/hermes-t3-gateway/`:

- `protocol.py`: two new frame types, following the existing `connection.hello`
  builder at `:83-104`.
- `adapter.py`: two new branches in `_handle_server_frame` (`:340-359`, which already
  dispatches `session.ensure` / `turn.start` / `ping` / …) for `describe.request` and
  `skill.body.request`.
- Reads needed: skills enumeration, and reasoning effort via
  `load_config_readonly()` — the same pattern as the existing `configured_model()`
  at `protocol.py:58-80`, including its degrade-to-omitted failure handling.
- **Read `integrations/hermes-t3-gateway/COMPATIBILITY.md` first.** It documents the
  exact audited upstream Hermes surfaces the plugin may touch (Hermes `62e07223` /
  v0.19.0). Any new `hermes_cli` read must be added there.

---

## Part 5 — The Agent page

**Route** — `apps/web/src/routes/agents.$instanceId.tsx`, TanStack file-based flat
dot-notation, `export const Route = createFileRoute(...)`. `routeTree.gen.ts` is
generated — do not hand-edit.

**Component** — `apps/web/src/components/agents/AgentPage.tsx` +
`AgentPage.logic.ts` + `AgentPage.logic.test.ts`. The logic/view split is an **enforced
convention** across this codebase (`HermesGatewayInstanceSection.logic.ts`,
`ConnectionsSettings.logic.ts`, `SettingsPanels.logic.ts`): all pure functions —
label maps, status→variant maps, timestamp formatting, error coercion — live in
`.logic.ts` with tests; the `.tsx` holds only React state and JSX.

**Layout** — reuse the settings design system wholesale
(`apps/web/src/components/settings/settingsLayout.tsx`):
`SettingsPageContainer` (:107-127) → `SettingsSection` (:18-42) per block.

Sections, in order:

1. **Status + identity** — the `<dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">`
   pattern from `HermesGatewayInstanceSection.tsx:243-267`. Status badge from the
   variant map at `:37-46`.
2. **Model + reasoning effort** — model display name, provider, resolved effort label,
   context window.
3. **Skills** — metadata rows (name, description, source badge, enabled). Reuse
   `formatProviderSkillDisplayName` and `formatProviderSkillInstallSource`
   (`apps/web/src/providerSkillPresentation.ts:16,26` — the latter already produces
   exactly the App/System/Project/Personal chip this wants) and `searchProviderSkills`
   (`providerSkillSearch.ts:70`) for the filter box. **On row expand**, fire
   `provider.getSkillBody` and render the markdown; cache per skill for the page's life.
4. **MCP servers** — v2. Render an explicit "not yet reported" empty state rather than
   omitting the section, so the page's shape is stable when it lands.

**Actions** (header row, `flex flex-wrap gap-2` of `size="sm"` buttons, each with its own
`<LoaderIcon className="animate-spin"/>` pending state and a shared `isBusy` disable —
the pattern at `HermesGatewayInstanceSection.tsx:290-345`):

- **Refresh** — re-run `provider.describeInstance`
- **Reconnect** — Hermes gateway reconnect via the broker
- **Open settings** — link to `/settings/providers` for the instance
- **New thread** — primary; creates a thread bound to this instance's agent project

**Data** — call the describe RPC via `useAtomCommand` +
`squashAtomCommandFailure` (`HermesGatewayInstanceSection.tsx:60-70`). For ambient
status, prefer the **push** path: `primaryServerProvidersAtom`
(`apps/web/src/state/server.ts:79-81`) already streams every `ServerProvider` via
`subscribeServerConfig` — no polling. `HermesGatewayInstanceSection.logic.ts:77-88`
(`hermesGatewayProviderSignal`) exists precisely for this and documents the tradeoff at
`:56-64`.

---

## Part 6 — Composer button + Agents sidebar section

**Button** — in `ComposerFooterModeControls` (`ChatComposer.tsx:267-320`), where the
Build toggle renders `{interactionMode === "plan" ? "Plan" : "Build"}` at `:315`. Hermes
already sets `showInteractionModeToggle: false`, so that slot is empty for Hermes today.
Render an agent button there when `requiresWorkspace === false`, using the existing
`apps/web/src/components/HermesIcon.tsx`, navigating to `/agents/$instanceId`. Build is
untouched for every other provider.

**Sidebar** — new top-level **Agents** section in `apps/web/src/components/Sidebar.tsx`,
peer to Projects, listing agent projects (`agentInstanceId !== null`) with their threads.
Render with the agent's icon and status dot rather than the folder icon and
`ProjectFavicon` (`Sidebar.tsx:2261`).

---

## Sequencing

Each step should typecheck and be usable on its own:

1. `requiresWorkspace` capability + gate the runtime-mode selector — **item 2 done**
2. Hide directory UI via `showComposerContextStrip` + header/headline branches — **item 1 done**
3. Synthetic agent projects (migration, lifecycle, picker filters)
4. Agents sidebar section
5. Describe RPC contract + default adapter implementation (Claude/Codex work immediately)
6. Agent page + route + composer button — **item 3 done**
7. Hermes plugin describe/skill-body handlers (fills the page for Hermes)

Steps 1–2 deliver the two removals with no schema work at all. Step 5's default
implementation means the page has real content before any plugin work lands.

---

## Verification

The dev server is already running against an isolated base dir with a live, connected
Hermes gateway:

- Web: `http://siva.davis7.space:5733/` — dev-runner with
  `--home-dir .t3/hermes-gateway-dev --host 0.0.0.0 --public-url http://siva.davis7.space:5733`
- Gateway: `hermes-gateway.service`, platform `t3` state `connected`
- Hermes CLI reads need `/home/davis/.hermes/hermes-agent/venv/bin/python` with
  `PYTHONPATH=/home/davis/.hermes/hermes-agent` — **system `python3` lacks `websockets`**
  and makes `check_requirements()` return `False`, which looks like a plugin bug

Manual checks:

1. Open a Hermes thread → no breadcrumb project, no checkout picker, no branch selector,
   no Open/Create PR, no runtime-mode selector. Headline reads "What's on your mind?".
2. Open a Claude/Codex thread in a real project → **everything above still present**.
   This is the regression that matters most; `requiresWorkspace` defaults to `true`, so
   any loss here means a gate was written inverted.
3. Narrow the window until the compact composer menu takes over → runtime mode still
   hidden for Hermes (the `CompactComposerControlsMenu` path is easy to miss).
4. Hermes composer shows the Hermes button; clicking opens `/agents/$instanceId`.
5. Agent page: status/model/effort populate; skills list renders; expanding a skill
   fetches its body; Refresh / Reconnect / Settings / New thread all work.
6. Sidebar: Hermes threads under Agents, not Projects; agent projects absent from every
   project picker.
7. Restart the server → agent project persists, threads still resolve.

Automated: `pnpm typecheck`, `pnpm test`, `pnpm lint`. New `.logic.test.ts` files
alongside each `.logic.ts` per the existing convention. Plugin tests live in
`integrations/hermes-t3-gateway/tests`.

## Open risk

The synthetic-project approach keeps a small fiction in the DB: agent threads reference a
project row that isn't a workspace. The `agentInstanceId` column makes it explicit and
filterable, but every new "list projects" surface must remember to filter. If that
proves leaky in practice, the migration to a nullable `project_id` remains available as a
follow-up — and the `agentInstanceId` column is exactly the discriminator that migration
would need anyway, so this is not wasted work.

## Found during implementation — follow-up surfaces

The synthetic project turns out to be leakier than the plan's "list projects" framing
suggested. Because an agent project is a **real, non-null project row**, every surface
that gates on `activeProject !== null` — rather than on a workspace capability — now
answers "yes" for a directoryless thread. Two classes of this were found:

- **Fixed in this change:** `ProjectScriptsControl` in `ChatHeader`. It gated on
  `activeProjectScripts &&`, and an agent project carries `scripts: []`, which is
  truthy — so the control rendered on a thread with no directory to run a script in.
  Now gated on `requiresWorkspace` as well.
- **Not fixed — deliberate scope hold.** `ChatView.tsx` gates the terminal
  (`:5518`), right panel (`:5521`), and file surfaces (`:6010`, `:6037`) on
  `activeProject !== null`. All three will be enabled for Hermes threads and point at
  `<t3home>/agents/<instanceId>/`, an empty directory. That is not _wrong_ — the
  directory is real and writable — but it is almost certainly not wanted, and deciding
  what a terminal should mean for an agent that owns its own machine is a product
  question this change did not have a mandate to answer.

The general lesson for the follow-up: `activeProject !== null` is no longer a reliable
proxy for "this thread has a workspace." `requiresWorkspace` is. A sweep replacing that
predicate at every capability-shaped call site would close the class, and is the natural
companion to the nullable-`project_id` migration already noted above.

## Agent projects are converge-on-read, not lifecycle-managed

The create-on-enrollment / delete-on-removal design above was replaced. Tying the
project's existence to enrollment events lets the system reach states it cannot recover
from without manual repair:

| Failure                                     | Lifecycle design                                        | `getOrCreateAgentProject`                |
| ------------------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| Enrollment succeeds, project dispatch fails | Instance has no project, permanently                    | Heals on next call                       |
| Instance enrolled before this shipped       | No project, ever                                        | Heals on next call                       |
| Project soft-deleted while instance is live | Threads unopenable                                      | Recreates                                |
| Two thread starts race                      | Duplicate-workspace-root rejection surfaces to the user | Loser re-reads and uses the winner's row |

`apps/server/src/orchestration/agentProjects.ts` exposes one function that reads and
creates only what is missing. It is a **precondition every caller runs**, not an event
one caller owns: the common path is a single indexed read on
`projection_projects.agent_instance_id`, so it is cheap enough to call on every agent
thread start. Enrollment may still call it to warm the row, but nothing depends on that
call having happened.

Wiring:

- Query: `ProjectionSnapshotQuery.getActiveAgentProject(instanceId)` — indexed lookup,
  `deleted_at IS NULL`, oldest-first so a duplicate resolves stably.
- RPC: `provider.ensureAgentProject` → `{ projectId, instanceId, workspaceRoot, title }`.
  Single-flighted per instance on the client so a burst of thread starts collapses to
  one call.
- The Agent page's **New thread** action calls it first and uses the returned
  `projectId`, rather than assuming a project exists.

The race-recovery read is the subtle part: the decider rejects a second project on the
same workspace root, so a losing concurrent caller sees a _dispatch failure_. It re-reads
before surfacing that error, and returns the winner's row if one now exists — a genuine
failure still propagates.

## "Reconnect" does not exist as an action

Part 5 lists **Reconnect — Hermes gateway reconnect via the broker** among the Agent
page's four actions. There is no such call, at any layer: `WS_METHODS` exposes only
createEnrollment / getInstanceStatus / listInstances / rename / revoke / remove, and
`HermesGatewayBrokerShape` has no reconnect method either.

That is not an oversight to fill in — it is architectural. **T3 never dials out.** The
plugin dials in to T3 and T3 accepts the socket, so there is no address for T3 to
reconnect _to_. Reconnection is the plugin's job; the only thing T3 can do is re-observe.

Implemented instead as a forced re-observe: `server.refreshProviders({ instanceId })`,
then — for gateway drivers only — `hermesGateway.getInstanceStatus` for the
authoritative state, then a quiet re-describe. The driver gate matters: a Claude or
Codex instance has no gateway status, and calling it anyway would surface
`instance-not-found` for what should be a no-op. If a genuine server-side reconnect ever
lands, one call swaps out.
