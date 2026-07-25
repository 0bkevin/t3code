# Hermes event compatibility inventory

The plugin deliberately uses only the public Hermes plugin and platform-adapter
surfaces audited at Hermes Agent commit
`3910ab28c0892fcf846fc61318d2fd15689eddf1`.

This inventory describes gateway wire protocol v2. Protocol v2 adds active-turn
recovery in `session.ready` and authoritative `content.snapshot` replacement;
older server/plugin pairs are rejected during the handshake.

## Mapped in the initial scope

| Hermes surface                            | T3 gateway event                               |
| ----------------------------------------- | ---------------------------------------------- |
| Cumulative `send` / `edit_message` output | `content.delta` / `content.snapshot`           |
| Final stream edit                         | `item.completed`, `turn.completed`             |
| `pre_tool_call` / `post_tool_call` hooks  | Typed `item.started` / `item.completed`        |
| Live adapter status text                  | Generic `unknown` activity item                |
| `send_exec_approval`                      | `request.opened` / `request.resolved`          |
| `send_clarify`                            | `user-input.requested` / `user-input.resolved` |
| `/steer` gateway command                  | `turn.steer`                                   |
| Adapter interrupt event                   | `turn.interrupt`                               |

## Known limitations

- The platform adapter receives cumulative rendered text, not the underlying
  token stream category. The current adapter maps it to `assistant_text`; Hermes reasoning,
  plan, and command-output stream categories are not publicly exposed here.
- Prefix-extending cumulative edits emit `content.delta`; edits that revise or
  clear already-emitted text emit an authoritative `content.snapshot`.
- Hermes' exact first-chat T3 home-channel notice is suppressed at the adapter
  output boundary. The plugin does not assign a home channel or redirect
  proactive delivery; other Hermes platform notices pass through unchanged.
- Hermes' documented tool hook surface exposes a `task_id`, tool name,
  arguments, string result, and duration. The audited runtime additionally
  supplies `session_id` and `tool_call_id`; the adapter uses them when present and falls
  back to the documented IDs for older versions. It projects only canonical,
  whitelisted fields (command/cwd, file path, search query, image path, or MCP
  server/operation); arbitrary arguments and raw results never cross the wire.
- Approval resolution is session-FIFO in Hermes. T3 request IDs identify the UI
  prompt, then resolve the oldest matching Hermes approval for that session.
- The public `clarify` hook is a single question. The wire protocol supports an
  array so richer structured input can be added without a protocol break.
- Hermes session completion has no dedicated platform-adapter callback. The
  plugin uses the stream consumer's required `finalize=True` edit as the
  authoritative completion boundary.
- Active `/steer` dispatch returns a textual Hermes control acknowledgement
  through the normal platform `send(..., notify=True)` path. The plugin
  captures that response in the originating steering request's async context,
  suppresses it from the transcript, and acknowledges T3 only when the audited
  Hermes success response begins with `⏩ Steer queued`. Unknown future response
  shapes fail closed with `protocol.error` rather than completing the turn.
- Attachments are not accepted. They are the first planned post-stability
  feature; the capability is reserved and fixed to `false` in protocol v2.
