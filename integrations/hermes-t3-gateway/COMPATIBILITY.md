# Hermes event compatibility inventory

The plugin deliberately uses only the public Hermes plugin and platform-adapter
surfaces audited at Hermes Agent upstream commit `62e07223` (v0.19.0).

Audited surfaces, all present at that commit:

| Surface                                  | Location at 62e07223                 |
| ---------------------------------------- | ------------------------------------ |
| `save_env_value` / `get_env_path`        | `hermes_cli/config.py:8137` / `:688` |
| `load_config_readonly`                   | `hermes_cli/config.py:7415`          |
| `skills_list` (registered tool)          | `tools/skills_tool.py:785`           |
| `skill_view` (registered tool)           | `tools/skills_tool.py:961`           |
| `build_session_key`                      | `gateway/session.py:1029`            |
| `resolve_gateway_approval`               | `tools/approval.py:2073`             |
| `resolve_gateway_clarify`                | `tools/clarify_gateway.py:160`       |
| `register_platform` (`**entry_kwargs`)   | `hermes_cli/plugins.py:931`          |
| `/steer` active-run handler              | `gateway/run.py:11280`               |
| Home-channel notice text                 | `gateway/run.py:13780`               |
| Active-command inline dispatch           | `gateway/platforms/base.py:4926`     |
| User-plugin path `$HERMES_HOME/plugins/` | `hermes_cli/plugins.py:10`, `:1350`  |

This inventory describes gateway wire protocol v2. Protocol v2 adds active-turn
recovery in `session.ready` and authoritative `content.snapshot` replacement;
older server/plugin pairs are rejected during the handshake.

## Mapped in the initial scope

| Hermes surface                                        | T3 gateway event                                  |
| ----------------------------------------------------- | ------------------------------------------------- |
| Cumulative `send` / `edit_message` output             | `content.delta` / `content.snapshot`              |
| Final stream edit                                     | `item.completed`, `turn.completed`                |
| `pre_tool_call` / `post_tool_call` hooks              | Typed `item.started` / `item.completed`           |
| Live adapter status text                              | `status_text` activity item                       |
| `load_config_readonly()["model"]["default"]`          | Optional `model` on `connection.hello`            |
| `send_exec_approval`                                  | `request.opened` / `request.resolved`             |
| `send_clarify`                                        | `user-input.requested` / `user-input.resolved`    |
| `/steer` gateway command                              | `turn.steer`                                      |
| Adapter interrupt event                               | `turn.interrupt`                                  |
| `load_config_readonly()["agent"]["reasoning_effort"]` | Optional `reasoningEffort` on `describe.response` |
| `skills_list()` metadata                              | `skills` on `describe.response`                   |
| `skill_view(name, preprocess=False)`                  | `markdown` on `skill.body.response`               |

## Known limitations

- The platform adapter receives cumulative rendered text, not the underlying
  token stream category. The current adapter maps it to `assistant_text`; Hermes reasoning,
  plan, and command-output stream categories are not publicly exposed here.
- Prefix-extending cumulative edits emit `content.delta`; edits that revise or
  clear already-emitted text emit an authoritative `content.snapshot`.
- Hermes' exact first-chat T3 home-channel notice is suppressed at the adapter
  output boundary. The plugin does not assign a home channel or redirect
  proactive delivery; other Hermes platform notices pass through unchanged.
  This match is **exact string equality**, which is fragile: Hermes builds the
  notice inline from an f-string (`gateway/run.py:13780`) rather than exporting
  a constant, so any wording change upstream silently stops the suppression and
  the notice reaches the transcript. Re-verified byte-for-byte at 62e07223 by
  reconstructing the f-string with `platform_name="t3"` (`Platform("t3").value`
  → `"t3"`, `.title()` → `"T3"`) and the non-Slack `/sethome` branch; it still
  matches. A regression test pins the literal.
- Hermes' documented tool hook surface exposes a `task_id`, tool name,
  arguments, string result, and duration. Verified at 62e07223: the runtime
  additionally supplies `session_id`, `tool_call_id`, `turn_id`,
  `api_request_id`, and `middleware_trace` on both hooks
  (`hermes_cli/plugins.py:2146` for `pre_tool_call`, `model_tools.py:1050` for
  `post_tool_call`), and `post_tool_call` also supplies `status`, `error_type`,
  and `error_message`. The adapter consumes `session_id`, `tool_call_id`, and
  `status` when present and falls back to the documented IDs for older
  versions. It projects only canonical, whitelisted fields (command/cwd, file
  path, search query, image path, or MCP server/operation); arbitrary arguments
  and raw results never cross the wire.
- `post_tool_call` passes `result` as `Any`, not a guaranteed `str` — the
  adapter never forwards it, so the looser type is inert here.
- Approval resolution is session-FIFO in Hermes. T3 request IDs identify the UI
  prompt, then resolve the oldest matching Hermes approval for that session.
- The public `clarify` hook is a single question. The wire protocol supports an
  array so richer structured input can be added without a protocol break.
- Hermes session completion has no dedicated platform-adapter callback. The
  plugin uses the stream consumer's required `finalize=True` edit as the
  authoritative completion boundary.
- Active `/steer` dispatch returns a textual Hermes control acknowledgement
  through the normal platform `send(..., notify=True)` path
  (`gateway/platforms/base.py:4926`). The plugin captures that response in the
  originating steering request's async context and suppresses it from the
  transcript. Because a steer targets a _running_ turn, the capture is
  correlated by the steering `requestId` — which the base adapter passes back
  as `reply_to` via `_reply_anchor_for_event` — and not by `chat_id`. Genuine
  assistant output emitted on the same thread during the steer window carries a
  different correlation id and reaches the transcript untouched.
- The plugin acknowledges T3 only when the audited Hermes success response
  begins with `⏩ Steer queued`. That prefix is likewise matched against an
  inline f-string (`gateway/run.py:11280`) rather than an exported constant, so
  it carries the same drift risk as the home-channel notice. Confirmed present
  at 62e07223. Unknown future response shapes fail closed with `protocol.error`
  rather than completing the turn.
- Hermes' configured default model is read once per handshake from the
  documented read-only accessor `load_config_readonly()["model"]["default"]`.
  That accessor returns the shared process-wide config cache and its docstring
  forbids mutation, so the plugin copies out only a trimmed string. Any failure
  — missing key, import error, older Hermes — omits the optional `model` field
  from `connection.hello` rather than sending null or empty.
- Hermes' configured reasoning effort is read from
  `load_config_readonly()["agent"]["reasoning_effort"]` on every
  `describe.request`, with the same discipline as the model read above: a
  trimmed string copy, no mutation of the shared cache, and any failure omits
  the optional `reasoningEffort` field rather than sending null or empty. Note
  this is the _global_ effort. Hermes also supports
  `agent.reasoning_overrides` (per-model) and `delegation.reasoning_effort`
  (subagents); neither is resolved here, so a user with a per-model override
  active sees the global value on the Agent page.
- Skills are enumerated through the registered `skills_list()` tool surface
  (`tools/skills_tool.py:785`), not the private `_find_all_skills()` scanner
  behind it. Consequences of that choice, all verified at 62e07223:
  - `skills_list()` already applies Hermes' disabled-skill, platform, and
    environment filters, so **disabled skills are absent from the list rather
    than reported with `enabled: false`**. The wire field is always `true`.
    Reporting disabled skills would require `_find_all_skills(skip_disabled=True)`
    plus `hermes_cli.skills_config.get_disabled_skills()` — a private scanner
    and a config-mutating module — so T3 shows what this Hermes would actually
    load, not the full on-disk inventory.
  - The surface publishes only `name`, `description`, and `category`. There is
    **no path or install-source field**: `category` is the nearest published
    analogue and is sent as `source`. The real on-disk path is available only
    from `skill_view()` per skill, so it is not eagerly fetched.
  - The list reflects `~/.hermes/skills/` plus configured `skills.external_dirs`,
    and is served from a 30s in-process cache keyed on a directory-mtime and
    disabled-set signature. A skill added seconds before a `describe.request`
    may be one refresh late.
  - MCP servers are not reported at all. Hermes has no public enumeration
    surface for them at this commit, and the T3 contract omits the field in v1.
- Skill bodies are read with `skill_view(name, preprocess=False)`. Preprocessing
  is disabled deliberately: T3 renders the skill for a human to read, so the
  literal authored markdown is wanted rather than Hermes' template and
  inline-shell rendering of it — the latter executes shell fragments embedded in
  the skill, which must not happen merely because a user expanded a row. Bodies
  are truncated at 512 KiB. Any failure — unknown name, ambiguous name across
  `external_dirs`, unreadable file, older Hermes — replies with `markdown: null`
  rather than an error, so the UI renders "no body available" instead of a
  protocol failure. The plugin calls `skill_view` directly rather than the
  registered `_skill_view_with_bump` handler, so a T3 body fetch does **not**
  bump that skill's view/use counters (`tools/skill_usage.py`) — browsing an
  agent's skills in T3 must not look like the agent loading one, since
  `last_used_at` is what Hermes' curator keys its stale-skill timer off.
- Neither describe frame can fail the connection over a _Hermes_ problem.
  Every Hermes-sourced read degrades — omitted optional field, empty skill
  list, or null markdown — so a `describe.request` against an older or
  partially-broken Hermes yields a thinner reply, never a `protocol.error`.
  The one exception is a malformed request: `skill.body.request` with no
  `skillName` cannot be answered, because the response echoes the name back
  and the wire type is non-empty. That takes the ordinary correlated
  `protocol.error` path.
- Attachments are not accepted. They are the first planned post-stability
  feature; the capability is reserved and fixed to `false` in protocol v2.
