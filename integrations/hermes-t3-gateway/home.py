"""Home-channel delivery: durable queue, classification, standalone sender.

Hermes-initiated output — cron results, the agent's `send_message` tool with a
bare `t3` target, gateway lifecycle notices, `/handoff t3` — has no T3-issued
turn to stream into. It is delivered as a `home.deliver` frame against the
instance's durable **home thread**, whose id T3 owns and republishes on every
`connection.accepted`.

Three concerns live here rather than in the adapter:

* **The durable queue.** A delivery is written to disk before it is sent and
  removed only when T3 acknowledges it, so nothing is lost when either side
  restarts mid-flight. T3 dedupes on `deliveryId`, which is what makes
  re-flushing the whole queue safe.
* **Kind/label classification.** Best-effort provenance recovery from the send
  context — see `classify_delivery`.
* **The standalone sender.** Out-of-process cron has no live adapter, so it
  dials T3 itself over a short-lived `role: "delivery"` socket.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from .protocol import (
    HOME_DELIVERY_KINDS,
    delivery_id,
    home_deliver,
    iso_now,
)

logger = logging.getLogger(__name__)

try:  # POSIX advisory locking; absent on Windows.
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None  # type: ignore[assignment]

# The env var carrying T3's home-thread designation.
#
# The name is NOT arbitrary. Hermes resolves a platform's cron home target with
# `_home_target_env_var` (`gateway/run.py:1541`), which falls back to
# `f"{PLATFORM.upper()}_HOME_CHANNEL"` for any platform without an override
# entry. Platform `t3` therefore resolves to exactly this string, so the
# `send_message` error hints, `/sethome` messaging, and cron's env-only
# resolution path all agree with the value the plugin writes — with no upstream
# override table entry required.
HOME_CHANNEL_ENV = "T3_HOME_CHANNEL"

# Queue location. `gateway/` under the Hermes home is the subdirectory Hermes'
# own bundled plugins use for per-profile adapter state (the Discord adapter's
# command-sync and non-conversational stores, `plugins/platforms/discord/
# adapter.py:52`, `:272`, `:1694`). Using `get_hermes_home()` as the base means
# the queue is profile-scoped for free: a second profile with its own
# `HERMES_HOME` gets its own queue rather than replaying another profile's
# deliveries into its own home thread.
QUEUE_SUBDIR = "gateway"
QUEUE_FILENAME = "t3_home_delivery_queue.jsonl"

# Bound the queue. Deliveries are small (a cron brief, a lifecycle line), so a
# few hundred is generous for any realistic outage while keeping the file
# readable and the flush bounded. Overflow drops the OLDEST entries: a
# fortnight-old cron brief is worth less than this morning's, and dropping
# newest would make a wedged queue permanently swallow current output.
MAX_QUEUE_ENTRIES = 300

# Bound one flush attempt. A reconnect must not spend minutes replaying before
# the connection is usable for live traffic; the remainder rides the next
# reconnect.
MAX_FLUSH_PER_CONNECT = 50


def hermes_home() -> Path:
    """Resolve Hermes' home directory, degrading to the documented default.

    Prefers Hermes' own accessor so a context-local profile override
    (`set_hermes_home_override`) is honoured, then `HERMES_HOME`, then the
    platform default. The plugin must not create state outside the active
    profile, but it also must not fail to queue a delivery merely because
    Hermes could not be imported (the standalone cron path can run in a very
    thin process).
    """
    try:
        from hermes_cli.config import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - queueing must never depend on Hermes importing
        pass
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - same
        pass
    override = os.environ.get("HERMES_HOME", "").strip()
    return Path(override) if override else Path.home() / ".hermes"


def queue_path() -> Path:
    return hermes_home() / QUEUE_SUBDIR / QUEUE_FILENAME


def home_thread_id() -> str:
    """Read the currently designated home thread from the environment."""
    return os.environ.get(HOME_CHANNEL_ENV, "").strip()


def save_home_thread_id(thread_id: str) -> bool:
    """Persist T3's home designation, mirroring it into this process.

    T3's settings blob is authoritative and this env var is a synced cache, so
    a differing local value is overwritten rather than merged — including one a
    user hand-edited (documented in the plugin README).

    Returns True when the value was durably written. A read-only or managed
    `.env` degrades to the in-process mirror only: routing works for the life
    of this gateway and re-reconciles on the next connect.
    """
    value = str(thread_id or "").strip()
    if not value:
        return False
    saved = False
    try:
        from hermes_cli.config import save_env_value

        save_env_value(HOME_CHANNEL_ENV, value)
        saved = True
    except Exception:  # noqa: BLE001 - a read-only .env must not break the handshake
        logger.warning(
            "Could not persist %s; T3 home delivery will use the in-process "
            "value until the next reconnect",
            HOME_CHANNEL_ENV,
            exc_info=True,
        )
    # Mirror into this process exactly as enrollment does (`cli.py`): the
    # running gateway resolves the home channel from the environment and must
    # not need a restart to see a freshly designated thread.
    os.environ[HOME_CHANNEL_ENV] = value
    return saved


class HomeDeliveryQueue:
    """Append-only JSONL outbox of unacknowledged `home.deliver` frames.

    Correctness rests on one rule: an entry is removed **only** when T3 acks
    its `deliveryId`. Everything else — a socket that dropped mid-send, a
    server that died before writing, a plugin that restarted — leaves the entry
    on disk to be replayed. Replay is safe because T3 dedupes on `deliveryId`,
    so the failure mode of this design is a duplicate suppressed server-side,
    never a lost delivery.

    Two processes can hold the same queue: the gateway adapter and an
    out-of-process cron run using the standalone sender. Writes take a POSIX
    advisory lock on a sidecar file where `fcntl` is available; on Windows the
    in-process lock alone applies and a concurrent cron process could in
    principle interleave a rewrite. The consequence there is a duplicate
    delivery (deduped by T3), not corruption of an already-acked entry.
    """

    def __init__(self, path: Path | None = None, max_entries: int = MAX_QUEUE_ENTRIES):
        self._path = Path(path) if path is not None else None
        self._max_entries = max(1, int(max_entries))
        self._lock = threading.RLock()

    @property
    def path(self) -> Path:
        # Resolved lazily, not in __init__: `get_hermes_home()` honours a
        # context-local profile override that may be installed after the
        # adapter is constructed.
        return self._path if self._path is not None else queue_path()

    def _ensure_parent(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read_lines(self) -> list[dict[str, Any]]:
        path = self.path
        if not path.exists():
            return []
        entries: list[dict[str, Any]] = []
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            logger.warning("Could not read the T3 home delivery queue", exc_info=True)
            return []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                # A torn write from a killed process. Skip the line rather than
                # discarding the whole queue.
                continue
            if isinstance(entry, dict) and entry.get("deliveryId"):
                entries.append(entry)
        return entries

    def _write_all(self, entries: list[dict[str, Any]]) -> None:
        self._ensure_parent()
        payload = "".join(
            json.dumps(entry, separators=(",", ":"), ensure_ascii=False) + "\n"
            for entry in entries
        )
        temporary = self.path.with_suffix(".jsonl.tmp")
        temporary.write_text(payload, encoding="utf-8")
        temporary.replace(self.path)

    def _file_lock(self):
        """Advisory cross-process lock, or a no-op where unavailable."""

        class _NoLock:
            def __enter__(self):
                return None

            def __exit__(self, *args):
                return False

        if fcntl is None:
            return _NoLock()

        queue = self.path
        try:
            queue.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            return _NoLock()

        class _FileLock:
            def __init__(self, lock_path: Path):
                self._lock_path = lock_path
                self._handle: Any = None

            def __enter__(self):
                try:
                    self._handle = open(self._lock_path, "a+")  # noqa: SIM115
                    fcntl.flock(self._handle, fcntl.LOCK_EX)
                except OSError:
                    if self._handle is not None:
                        self._handle.close()
                    self._handle = None
                return None

            def __exit__(self, *args):
                if self._handle is not None:
                    try:
                        fcntl.flock(self._handle, fcntl.LOCK_UN)
                    finally:
                        self._handle.close()
                        self._handle = None
                return False

        return _FileLock(queue.with_suffix(".jsonl.lock"))

    def append(self, frame: dict[str, Any]) -> bool:
        """Persist one delivery. Returns False when it could not be written."""
        if not isinstance(frame, dict) or not frame.get("deliveryId"):
            return False
        with self._lock, self._file_lock():
            entries = self._read_lines()
            if any(
                entry.get("deliveryId") == frame["deliveryId"] for entry in entries
            ):
                return True
            entries.append(dict(frame))
            dropped = len(entries) - self._max_entries
            if dropped > 0:
                logger.warning(
                    "T3 home delivery queue is full (%d entries); dropping the "
                    "%d oldest undelivered %s",
                    self._max_entries,
                    dropped,
                    "delivery" if dropped == 1 else "deliveries",
                )
                entries = entries[dropped:]
            try:
                self._write_all(entries)
            except OSError:
                logger.error(
                    "Could not persist a T3 home delivery to %s",
                    self.path,
                    exc_info=True,
                )
                return False
        return True

    def entries(self) -> list[dict[str, Any]]:
        """Every unacknowledged delivery, oldest first."""
        with self._lock:
            return self._read_lines()

    def purge(self, delivery_id_value: str) -> bool:
        """Remove one acknowledged delivery. Returns True when it was present."""
        target = str(delivery_id_value or "").strip()
        if not target:
            return False
        with self._lock, self._file_lock():
            entries = self._read_lines()
            remaining = [
                entry for entry in entries if entry.get("deliveryId") != target
            ]
            if len(remaining) == len(entries):
                return False
            try:
                self._write_all(remaining)
            except OSError:
                logger.error(
                    "Could not purge acknowledged T3 home delivery %s from %s",
                    target,
                    self.path,
                    exc_info=True,
                )
                return False
        return True

    def __len__(self) -> int:
        return len(self.entries())


# ── classification ────────────────────────────────────────────────────────

# Hermes' lifecycle broadcasts, matched by their literal shapes at 62e07223.
# These are inline f-strings upstream, not exported constants, so the same
# drift risk documented for the `/sethome` notice applies: a wording change
# upstream downgrades these to `kind: "message"`, which costs a badge and a
# quiet-delivery classification, never the delivery itself.
_LIFECYCLE_EXACT = frozenset(
    {
        # gateway/run.py:17277
        "♻️ Gateway online — Hermes is back and ready.",
        # gateway/run.py:17236
        "♻ Gateway restarted successfully. Your session continues.",
    }
)
_LIFECYCLE_PREFIXES = (
    # gateway/run.py:6599 — f"⚠️ Gateway {action} — {hint}"
    "⚠️ Gateway restarting — ",
    "⚠️ Gateway shutting down — ",
)

# cron/scheduler.py:1513 builds this header when `cron.wrap_response` is on
# (the default).
_CRON_HEADER = "Cronjob Response: "

# gateway/run.py:8854 — the handoff destination's synthetic source identity.
_HANDOFF_USER_ID = "system:handoff"


def classify_delivery(
    content: str,
    metadata: dict[str, Any] | None = None,
    *,
    session_user_id: str = "",
) -> tuple[str, str, bool]:
    """Best-effort `(kind, label, provenance_certain)` for a proactive send.

    Hermes' `adapter.send()` contract carries no structured "this is a cron
    delivery" marker on every path, so this reads the signals that do exist:

    * **`metadata["job_id"]`** — the cron scheduler stamps it into the routed
      metadata for every live-gateway delivery (`cron/scheduler.py:1782`), and
      `DeliveryRouter._deliver_to_platform` passes that dict through to
      `adapter.send` unchanged (`gateway/delivery.py:606`). This is the
      strongest signal available and the only structured one.
    * **The cron wrap header** — `cron.wrap_response` (default on) prefixes the
      brief with `Cronjob Response: <name>` (`cron/scheduler.py:1513`), which
      also supplies a human job name for the badge.
    * **Lifecycle literals** — the gateway's online/restart/shutdown notices.
    * **The bound session identity** — `/handoff` dispatches its synthetic turn
      under `user_id="system:handoff"` (`gateway/run.py:8854`), bound onto the
      session context by `_set_session_env` (`gateway/run.py:17372`).

    The third element reports whether provenance was *positively* established.
    The adapter uses it as the tiebreaker when a live turn exists in the home
    thread: only a positively-identified proactive send may bypass that turn,
    so an unclassifiable send can never steal a user's answer.

    Worst case for the first two elements is a wrong badge, never a lost
    delivery — an unrecognised send is `("message", "Hermes", False)`.
    """
    text = str(content or "")
    meta = metadata or {}

    job_id = str(meta.get("job_id") or "").strip()
    job_name = _cron_job_name(text)
    if job_id or job_name:
        label = f"Cron: {job_name or job_id}"
        return "cron", label, True

    stripped = text.strip()
    if stripped in _LIFECYCLE_EXACT or stripped.startswith(_LIFECYCLE_PREFIXES):
        return "lifecycle", "Gateway", True

    if str(session_user_id or "").strip() == _HANDOFF_USER_ID:
        return "handoff", "Handoff", True

    return "message", "Hermes", False


def _cron_job_name(text: str) -> str:
    """Recover the job name from the cron wrap header, if present."""
    first_line = text.lstrip().split("\n", 1)[0]
    if not first_line.startswith(_CRON_HEADER):
        return ""
    return first_line[len(_CRON_HEADER) :].strip()


def build_delivery(
    *,
    thread_id: str,
    text: str,
    kind: str = "message",
    label: str = "Hermes",
    created_at: str | None = None,
) -> dict[str, Any]:
    """Mint one `home.deliver` frame, id and timestamp included.

    `createdAt` is stamped here — when Hermes produced the content — not when
    the frame reaches T3, so a delivery flushed after a two-hour outage still
    reports the moment it was written.
    """
    normalized_kind = kind if kind in HOME_DELIVERY_KINDS else "other"
    return home_deliver(
        delivery_id_value=delivery_id(),
        thread_id=thread_id,
        kind=normalized_kind,
        label=label,
        text=text,
        created_at=created_at or iso_now(),
    )


# ── standalone (out-of-process) sender ────────────────────────────────────


async def standalone_send(
    pconfig: Any,
    chat_id: str,
    message: str,
    *,
    thread_id: str | None = None,
    media_files: list[str] | None = None,
    force_document: bool = False,
) -> dict[str, Any]:
    """Deliver to the home thread with no live gateway adapter in this process.

    Registered as `standalone_sender_fn` and called by
    `tools/send_message_tool._send_via_adapter` when the in-process adapter
    weakref is empty — the `hermes cron` process running separately from
    `hermes gateway`. Without it, `deliver=t3` cron jobs fail with "No live
    adapter for platform".

    The socket announces `role: "delivery"`. That is load-bearing: T3's broker
    registers a `gateway` connection under generation fencing and displaces the
    previous one, so a naive cron dial-in would kick the live gateway socket
    off its own instance mid-turn. A `delivery` connection is authenticated
    identically, never becomes the primary, and is expected to close promptly.

    A connection failure is **not** a cron failure. The delivery is already on
    disk before the socket is opened, so the job reports success-with-queued
    and the live gateway flushes it on its next `connection.accepted`.

    `media_files` and `force_document` are accepted for signature parity
    (`gateway/platform_registry.py:150-158`); the v3 wire contract carries no
    attachment framing, so they are ignored.
    """
    del force_document
    if media_files:
        logger.info(
            "T3 standalone send ignoring %d media file(s): the v3 gateway "
            "contract has no attachment framing",
            len(media_files),
        )

    extra = getattr(pconfig, "extra", None) or {}

    def _setting(key: str, env: str) -> str:
        return str(extra.get(key) or os.environ.get(env, "") or "").strip()

    url = _setting("url", "HERMES_T3_GATEWAY_URL")
    instance_id = _setting("instance_id", "HERMES_T3_GATEWAY_INSTANCE_ID")
    credential = _setting("credential", "HERMES_T3_GATEWAY_CREDENTIAL")
    if not (url and instance_id and credential):
        return {
            "error": (
                "T3 standalone send: this Hermes is not enrolled. Run "
                "`hermes t3 connect --url <url> --token <token>` first."
            )
        }

    target = str(chat_id or "").strip() or str(thread_id or "").strip()
    if not target:
        target = home_thread_id()
    if not target:
        return {
            "error": (
                "T3 standalone send: no home thread is designated. Start "
                "`hermes gateway` once so T3 can publish one."
            )
        }

    kind, label, _certain = classify_delivery(message, None)
    frame = build_delivery(thread_id=target, text=message, kind=kind, label=label)
    delivery = str(frame["deliveryId"])

    queue = HomeDeliveryQueue()
    queued = queue.append(frame)

    try:
        acked = await _deliver_over_short_lived_socket(
            url=url,
            instance_id=instance_id,
            credential=credential,
            frame=frame,
        )
    except Exception as exc:  # noqa: BLE001 - cron delivery must not raise
        logger.debug("T3 standalone send raised", exc_info=True)
        if queued:
            return {
                "success": True,
                "message_id": delivery,
                "queued": True,
                "detail": f"T3 unreachable ({exc}); queued for the next connect",
            }
        return {"error": f"T3 standalone send failed: {exc}"}

    if acked:
        queue.purge(delivery)
        return {"success": True, "message_id": delivery}
    if queued:
        return {
            "success": True,
            "message_id": delivery,
            "queued": True,
            "detail": "T3 did not acknowledge the delivery; queued for retry",
        }
    return {"error": "T3 standalone send: the delivery was neither acked nor queued"}


async def _deliver_over_short_lived_socket(
    *,
    url: str,
    instance_id: str,
    credential: str,
    frame: dict[str, Any],
    timeout: float = 20.0,
) -> bool:
    """Open, authenticate as `delivery`, send, await the ack, close."""
    import asyncio

    from .connection import _open_socket, authenticate_socket

    hermes_version = _hermes_version()
    socket = await _open_socket(url)
    try:
        await authenticate_socket(
            socket,
            authentication={
                "type": "instance-credential",
                "instanceId": instance_id,
                "credential": credential,
            },
            hermes_version=hermes_version,
            role="delivery",
        )
        await socket.send(
            json.dumps(frame, separators=(",", ":"), ensure_ascii=False)
        )
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return False
            raw = await asyncio.wait_for(socket.recv(), timeout=remaining)
            try:
                reply = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(reply, dict):
                continue
            if reply.get("type") == "home.deliver.ack" and str(
                reply.get("deliveryId") or ""
            ) == str(frame["deliveryId"]):
                return True
            # Anything else (a liveness ping, an unrelated frame) is ignored:
            # this socket exists only to hand over one delivery.
    finally:
        try:
            await socket.close()
        except Exception:  # noqa: BLE001 - a failed close must not fail the send
            logger.debug("T3 standalone socket close failed", exc_info=True)


def _hermes_version() -> str:
    try:
        from hermes_cli import __version__

        return str(__version__)
    except Exception:  # noqa: BLE001 - version discovery must not block delivery
        return "unknown"
