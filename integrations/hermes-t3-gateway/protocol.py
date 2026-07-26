"""Pure-Python helpers for the T3 Code ↔ Hermes gateway wire contract."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

PROTOCOL_VERSION = 3
PLUGIN_VERSION = "0.3.0"
WEBSOCKET_PATH = "/api/hermes-gateway/ws"

# What a connecting socket intends to be. `gateway` is the instance's one live
# plugin connection; `delivery` is a short-lived socket (an out-of-process cron
# run) that hands over a `home.deliver` and leaves. T3 never registers a
# `delivery` socket as the primary connection, so it cannot displace a healthy
# gateway connection under the broker's generation fencing.
CONNECTION_ROLES = frozenset({"gateway", "delivery"})

CAPABILITIES = {
    "protocolVersion": PROTOCOL_VERSION,
    "streaming": True,
    "activity": True,
    "approvals": True,
    "userInput": True,
    # First post-stability feature: advertise false until binary/media framing
    # and bounded attachment transfer are implemented end to end.
    "attachments": False,
}

SERVER_COMMANDS = frozenset(
    {
        "session.ensure",
        "turn.start",
        "turn.steer",
        "turn.interrupt",
        "approval.respond",
        "user-input.respond",
        "session.stop",
        "ping",
        "describe.request",
        "skill.body.request",
        "home.deliver.ack",
    }
)

# Kinds a `home.deliver` may carry. Mirrors the T3 contract's
# `HermesGatewayHomeDeliveryKind`; anything not classified lands on "message".
HOME_DELIVERY_KINDS = frozenset({"cron", "message", "lifecycle", "handoff", "other"})

# Wire bounds from the T3 contract (`HermesGatewayHomeDeliver`): `label` is a
# trimmed non-empty string of at most 200 chars, `text` is 1..120000 chars.
# Enforced here so a pathological Hermes payload is clamped rather than
# rejected by the server after the plugin already dropped its local copy.
MAX_HOME_DELIVERY_LABEL_CHARS = 200
MAX_HOME_DELIVERY_TEXT_CHARS = 120_000

# Ceiling on a single skill body crossing the wire. Skill markdown is
# human-authored documentation, not data: 512 KiB is far past any real
# SKILL.md while still bounding a pathological file from stalling the socket.
MAX_SKILL_BODY_CHARS = 512_000


def request_id() -> str:
    return str(uuid.uuid4())


def item_id() -> str:
    return str(uuid.uuid4())


def delivery_id() -> str:
    """Mint the idempotency key for one home delivery.

    Stable across retries by construction: the id is minted once, when the
    delivery is created, and the queued copy carries it verbatim through every
    flush. T3 dedupes on it, which is what makes double-flushing safe.
    """
    return str(uuid.uuid4())


def delivery_id() -> str:
    """Mint the idempotency key for one home delivery.

    Stable across retries by construction: the id is minted once, when the
    delivery is created, and the queued copy carries it verbatim through every
    flush. T3 dedupes on it, which is what makes double-flushing safe.
    """
    return str(uuid.uuid4())


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def frame(frame_type: str, **payload: Any) -> dict[str, Any]:
    return {
        "type": frame_type,
        "protocolVersion": PROTOCOL_VERSION,
        **payload,
    }


def configured_model() -> str | None:
    """Return Hermes' configured default model, or None when unavailable.

    Reads `hermes_cli.config.load_config_readonly()`, the documented read-only
    accessor. That function returns the *shared, process-wide cached* config
    dict, so nothing here mutates it or hands a nested structure to a caller
    that might: only a trimmed string copy of `model.default` leaves this
    function.

    Every failure mode — no Hermes on the path, an older Hermes without the
    accessor, a config with no model section — degrades to None so the field is
    omitted from the handshake rather than sent as null or empty.
    """
    try:
        from hermes_cli.config import load_config_readonly

        model = load_config_readonly().get("model", {}).get("default")
    except Exception:  # noqa: BLE001 - model reporting must never break the handshake
        return None
    if not isinstance(model, str):
        return None
    trimmed = model.strip()
    return trimmed or None


def configured_reasoning_effort() -> str | None:
    """Return Hermes' configured reasoning effort, or None when unavailable.

    Same discipline as `configured_model()`: `load_config_readonly()` hands
    back the *shared, process-wide cached* config dict, so this reads
    `agent.reasoning_effort` and copies out a trimmed string — nothing here
    mutates the cache or lets a nested structure escape to a caller that
    might.

    Every failure mode — no Hermes on the path, an older Hermes without the
    accessor, a config with no `agent` section, a non-string value — degrades
    to None so the field is omitted from `describe.response` rather than sent
    as null or empty.
    """
    try:
        from hermes_cli.config import load_config_readonly

        effort = load_config_readonly().get("agent", {}).get("reasoning_effort")
    except Exception:  # noqa: BLE001 - describe must never break the connection
        return None
    if not isinstance(effort, str):
        return None
    trimmed = effort.strip()
    return trimmed or None


def installed_skills() -> list[dict[str, Any]]:
    """Return metadata for the skills Hermes currently exposes.

    Reads the documented `tools.skills_tool.skills_list()` tool surface — the
    same JSON the agent itself sees — rather than the private `_find_all_skills`
    scanner behind it. `skills_list()` already applies Hermes' platform,
    environment, and disabled-skill filters, so every entry it returns is a
    skill this Hermes would actually load; `enabled` is therefore always True
    here and disabled skills are simply absent (see COMPATIBILITY.md).

    Only trimmed string copies of `name`, `description`, and `category` leave
    this function: the payload is rebuilt entry by entry so nothing Hermes owns
    — cached or otherwise — is handed to a caller that might mutate it.

    Every failure mode — no Hermes on the path, an older Hermes without the
    tool, a non-JSON or unsuccessful response, a malformed entry — degrades to
    an empty list. Describing an agent must never break the connection.
    """
    try:
        from tools.skills_tool import skills_list

        payload = json.loads(skills_list())
    except Exception:  # noqa: BLE001 - describe must never break the connection
        return []
    if not isinstance(payload, dict) or not payload.get("success"):
        return []
    entries = payload.get("skills")
    if not isinstance(entries, list):
        return []
    skills: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        skill: dict[str, Any] = {"name": name.strip(), "enabled": True}
        description = entry.get("description")
        if isinstance(description, str) and description.strip():
            skill["description"] = description.strip()
        # Hermes' category is the closest thing it publishes to an install
        # source. There is no on-disk path in this surface; see COMPATIBILITY.md.
        source = entry.get("category")
        if isinstance(source, str) and source.strip():
            skill["source"] = source.strip()
        skills.append(skill)
    return skills


def skill_body(name: str) -> str | None:
    """Return a skill's SKILL.md markdown, or None when unavailable.

    Reads the documented `tools.skills_tool.skill_view()` tool surface with
    `preprocess=False`: T3 renders the skill for a human to read, so the
    literal authored markdown is wanted, not Hermes' template/inline-shell
    rendering of it.

    Unlike the omit-on-failure optional fields, `markdown` is explicitly null
    on failure: the request named a specific skill, so the caller needs to
    distinguish "asked and there is nothing to show" from a dropped reply.
    A missing skill, an unreadable file, an ambiguous name, an older Hermes,
    or no Hermes at all all land on None.
    """
    if not isinstance(name, str) or not name.strip():
        return None
    try:
        from tools.skills_tool import skill_view

        payload = json.loads(skill_view(name.strip(), preprocess=False))
    except Exception:  # noqa: BLE001 - describe must never break the connection
        return None
    if not isinstance(payload, dict) or not payload.get("success"):
        return None
    content = payload.get("content")
    if not isinstance(content, str) or not content.strip():
        return None
    return content[:MAX_SKILL_BODY_CHARS]


def describe_response(
    *,
    request_id_value: str,
    hermes_version: str,
    model: str | None = None,
    reasoning_effort: str | None = None,
    skills: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the reply to a `describe.request`.

    Mirrors `connection_hello`: the version/capability block is always present
    because the plugin owns it outright, while every Hermes-sourced optional
    field is *omitted* when it cannot be read rather than sent as null or
    empty, so a server that has the field still falls back to its own generic
    label. `skills` is always present — an empty list is the truthful answer
    when Hermes reports none, and it keeps the client's rendering shape stable.
    """
    resolved_model = model if model is not None else configured_model()
    resolved_effort = (
        reasoning_effort
        if reasoning_effort is not None
        else configured_reasoning_effort()
    )
    resolved_skills = installed_skills() if skills is None else skills
    payload: dict[str, Any] = {
        "type": "describe.response",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id_value,
        "pluginVersion": PLUGIN_VERSION,
        "hermesVersion": hermes_version,
        "capabilities": dict(CAPABILITIES),
        "skills": [dict(skill) for skill in resolved_skills],
        "describedAt": iso_now(),
    }
    if resolved_model:
        payload["model"] = resolved_model
    if resolved_effort:
        payload["reasoningEffort"] = resolved_effort
    return payload


def skill_body_response(
    *,
    request_id_value: str,
    skill_name: str,
    markdown: str | None,
) -> dict[str, Any]:
    """Build the reply to a `skill.body.request`.

    `markdown` is explicitly nullable here — the request named a skill, so the
    caller must be able to tell "Hermes has no body to show for this" apart
    from a reply that never arrived. Empty strings normalize to null.
    """
    return {
        "type": "skill.body.response",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id_value,
        "skillName": skill_name,
        "markdown": markdown if markdown else None,
    }


def connection_hello(
    *,
    hermes_version: str,
    authentication: dict[str, str],
    hello_request_id: str | None = None,
    model: str | None = None,
    role: str = "gateway",
) -> dict[str, Any]:
    """Build the handshake frame.

    `role` is sent explicitly even though the T3 contract decodes a missing
    value as `"gateway"`: an out-of-process cron sender MUST announce
    `"delivery"` or the broker registers it as the instance's primary
    connection and generation-fences the live gateway socket off.
    """
    resolved_model = model if model is not None else configured_model()
    normalized_role = str(role or "gateway").strip().lower()
    if normalized_role not in CONNECTION_ROLES:
        normalized_role = "gateway"
    hello: dict[str, Any] = {
        "type": "connection.hello",
        "requestId": hello_request_id or request_id(),
        "protocolVersion": PROTOCOL_VERSION,
        "pluginVersion": PLUGIN_VERSION,
        "hermesVersion": hermes_version,
        "capabilities": dict(CAPABILITIES),
        "authentication": authentication,
        "role": normalized_role,
    }
    # Optional on the wire: omit entirely rather than send null/empty so a
    # server that has the field still falls back to its generic label.
    if resolved_model:
        hello["model"] = resolved_model
    return hello


def home_deliver(
    *,
    delivery_id_value: str,
    thread_id: str,
    kind: str,
    label: str,
    text: str,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Build a `home.deliver` frame with every wire bound already applied.

    Like `protocol_error`, this wraps the generic `frame()` helper rather than
    assembling the envelope itself — but unlike the plain outbound frames the
    adapter builds inline, a delivery has server-side validation the plugin
    must not trip: `label` is trimmed non-empty ≤200 chars and `text` is
    1..120000 chars in the T3 contract. Normalizing here rather than at the
    call sites means a queued delivery is already wire-valid on disk, so a
    flush after a plugin upgrade cannot resurrect a payload the server will
    reject — the plugin would purge it only on an ack that never comes.

    An unknown `kind` degrades to `"other"` and an empty label to `"Hermes"`:
    a misclassified badge is the documented worst case, a dropped delivery is
    not.
    """
    normalized_kind = str(kind or "").strip().lower()
    if normalized_kind not in HOME_DELIVERY_KINDS:
        normalized_kind = "other"
    normalized_label = str(label or "").strip()[:MAX_HOME_DELIVERY_LABEL_CHARS].strip()
    if not normalized_label:
        normalized_label = "Hermes"
    normalized_text = str(text or "")[:MAX_HOME_DELIVERY_TEXT_CHARS]
    if not normalized_text:
        normalized_text = " "
    return frame(
        "home.deliver",
        deliveryId=delivery_id_value,
        threadId=str(thread_id),
        kind=normalized_kind,
        label=normalized_label,
        text=normalized_text,
        createdAt=created_at or iso_now(),
    )


def home_deliver(
    *,
    delivery_id_value: str,
    thread_id: str,
    kind: str,
    label: str,
    text: str,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Build a `home.deliver` frame with every wire bound already applied.

    Like `protocol_error`, this wraps the generic `frame()` helper rather than
    assembling the envelope itself — but unlike the plain outbound frames the
    adapter builds inline, a delivery has server-side validation the plugin
    must not trip: `label` is trimmed non-empty <=200 chars and `text` is
    1..120000 chars in the T3 contract. Normalizing here rather than at the
    call sites means a queued delivery is already wire-valid on disk, so a
    flush after a plugin upgrade cannot resurrect a payload the server will
    reject — the plugin would purge it only on an ack that never comes.

    An unknown `kind` degrades to `"other"` and an empty label to `"Hermes"`:
    a misclassified badge is the documented worst case, a dropped delivery is
    not.
    """
    normalized_kind = str(kind or "").strip().lower()
    if normalized_kind not in HOME_DELIVERY_KINDS:
        normalized_kind = "other"
    normalized_label = str(label or "").strip()[:MAX_HOME_DELIVERY_LABEL_CHARS].strip()
    if not normalized_label:
        normalized_label = "Hermes"
    normalized_text = str(text or "")[:MAX_HOME_DELIVERY_TEXT_CHARS]
    if not normalized_text:
        normalized_text = " "
    return frame(
        "home.deliver",
        deliveryId=delivery_id_value,
        threadId=str(thread_id),
        kind=normalized_kind,
        label=normalized_label,
        text=normalized_text,
        createdAt=created_at or iso_now(),
    )


def protocol_error(
    code: str,
    message: str,
    *,
    recoverable: bool,
    related_request_id: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "code": code,
        "message": message,
        "recoverable": recoverable,
    }
    if related_request_id:
        payload["requestId"] = related_request_id
    return frame("protocol.error", **payload)


def validate_server_frame(message: Any) -> dict[str, Any]:
    if not isinstance(message, dict):
        raise TypeError("gateway frame must be a JSON object")
    frame_type = message.get("type")
    if frame_type not in SERVER_COMMANDS:
        raise ValueError(f"unsupported T3 gateway frame: {frame_type!r}")
    if message.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError(
            f"unsupported protocol version: {message.get('protocolVersion')!r}"
        )
    return message


def canonical_tool_item_type(tool_name: str) -> str:
    normalized = (tool_name or "").strip().lower()
    if normalized in {"terminal", "execute_code", "shell", "bash"}:
        return "command_execution"
    if normalized in {
        "apply_patch",
        "write_file",
        "edit_file",
        "delete_file",
        "move_file",
    }:
        return "file_change"
    if normalized.startswith(("mcp", "mcp__")):
        return "mcp_tool_call"
    if normalized in {"delegate_task", "spawn_agent", "send_message"}:
        return "collab_agent_tool_call"
    if "search" in normalized or normalized in {"web_fetch", "fetch_url"}:
        return "web_search"
    if normalized in {"view_image", "open_image"}:
        return "image_view"
    return "dynamic_tool_call"


def canonical_tool_data(tool_name: str, args: Any) -> dict[str, Any] | None:
    """Project known-safe, canonical fields; never forward arbitrary tool args."""
    if not isinstance(args, dict):
        return None
    item_type = canonical_tool_item_type(tool_name)
    if item_type == "command_execution":
        command = args.get("command")
        cwd = args.get("cwd") or args.get("workdir")
        projected = {}
        if isinstance(command, str) and command.strip():
            projected["command"] = command[:4_000]
        if isinstance(cwd, str) and cwd.strip():
            projected["cwd"] = cwd[:1_000]
        return projected or None
    if item_type == "file_change":
        path = args.get("path") or args.get("file_path") or args.get("filename")
        return (
            {"path": path[:1_000]} if isinstance(path, str) and path.strip() else None
        )
    if item_type == "web_search":
        query = args.get("query") or args.get("q") or args.get("url")
        return (
            {"query": query[:2_000]}
            if isinstance(query, str) and query.strip()
            else None
        )
    if item_type == "image_view":
        path = args.get("path") or args.get("image_path")
        return (
            {"path": path[:1_000]} if isinstance(path, str) and path.strip() else None
        )
    if item_type == "mcp_tool_call":
        server = args.get("server")
        operation = args.get("tool") or args.get("operation")
        projected = {}
        if isinstance(server, str) and server.strip():
            projected["server"] = server[:200]
        if isinstance(operation, str) and operation.strip():
            projected["operation"] = operation[:200]
        return projected or None
    return None
