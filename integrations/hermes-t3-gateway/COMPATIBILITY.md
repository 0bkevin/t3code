# Hermes event compatibility inventory

The plugin deliberately uses only the public Hermes plugin and platform-adapter
surfaces audited at Hermes Agent upstream commit `62e07223` (v0.19.0).

Audited surfaces, all present at that commit:

| Surface                                  | Location at 62e07223                 |
| ---------------------------------------- | ------------------------------------ |
| `save_env_value` / `get_env_path`        | `hermes_cli/config.py:8137` / `:688` |
| `load_config_readonly`                   | `hermes_cli/config.py:7415`          |
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

| Hermes surface                               | T3 gateway event                               |
| -------------------------------------------- | ---------------------------------------------- |
| Cumulative `send` / `edit_message` output    | `content.delta` / `content.snapshot`           |
| Final stream edit                            | `item.completed`, `turn.completed`             |
| `pre_tool_call` / `post_tool_call` hooks     | Typed `item.started` / `item.completed`        |
| Live adapter status text                     | `status_text` activity item                    |
| `load_config_readonly()["model"]["default"]` | Optional `model` on `connection.hello`         |
| `send_exec_approval`                         | `request.opened` / `request.resolved`          |
| `send_clarify`                               | `user-input.requested` / `user-input.resolved` |
| `/steer` gateway command                     | `turn.steer`                                   |
| Adapter interrupt event                      | `turn.interrupt`                               |

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
- Attachments are not accepted. They are the first planned post-stability
  feature; the capability is reserved and fixed to `false` in protocol v2.
