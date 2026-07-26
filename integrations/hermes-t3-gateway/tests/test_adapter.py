from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import enum
import importlib.util
import pathlib
import sys
import types
import unittest
import unittest.mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = "hermes_t3_gateway_adapter_test"


class Platform(str, enum.Enum):
    T3 = "t3"

    @classmethod
    def _missing_(cls, value):
        if value == "t3":
            return cls.T3
        return None


@dataclasses.dataclass
class PlatformConfig:
    enabled: bool = True
    extra: dict = dataclasses.field(default_factory=dict)


class MessageType(enum.Enum):
    TEXT = "text"
    COMMAND = "command"


@dataclasses.dataclass
class MessageEvent:
    text: str
    message_type: MessageType
    source: object
    message_id: str
    metadata: dict


@dataclasses.dataclass
class SendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None


@dataclasses.dataclass
class Source:
    platform: Platform
    chat_id: str
    message_id: str


class BasePlatformAdapter:
    def __init__(self, config, platform):
        self.config = config
        self.platform = platform
        self._status_text = {}
        self.messages = []
        self._running = False
        self._message_handler = None

    def build_source(self, *, chat_id, message_id, **kwargs):
        return Source(self.platform, str(chat_id), str(message_id))

    async def handle_message(self, event):
        self.messages.append(event)
        if (
            self._message_handler is not None
            and event.message_type == MessageType.COMMAND
            and event.text.startswith("/steer ")
        ):
            # Faithful model of Hermes BasePlatformAdapter's active-command
            # bypass path (gateway/platforms/base.py ~4926 at upstream
            # 62e07223): the gateway handler returns a control
            # acknowledgement, then the base adapter sends it through the
            # platform adapter with `reply_to=_reply_anchor_for_event(event)`
            # — which, for a platform with no thread_id, is the dispatched
            # event's own message_id — and notify=True metadata.
            response = await self._message_handler(event)
            if response:
                await self.send(
                    event.source.chat_id,
                    response,
                    reply_to=event.message_id,
                    metadata={"notify": True},
                )

    async def interrupt_session_activity(self, session_key, chat_id):
        self.interrupted = (session_key, chat_id)

    def set_status_text(self, chat_id, text):
        if text:
            self._status_text[str(chat_id)] = text
        else:
            self._status_text.pop(str(chat_id), None)

    def _mark_connected(self):
        self._running = True

    def _mark_disconnected(self):
        self._running = False

    def _set_fatal_error(self, *args, **kwargs):
        self.fatal_error = (args, kwargs)


def build_session_key(source):
    return f"agent:main:t3:dm:{source.chat_id}"


def install_fake_hermes_modules():
    gateway = types.ModuleType("gateway")
    config = types.ModuleType("gateway.config")
    config.Platform = Platform
    config.PlatformConfig = PlatformConfig
    platforms = types.ModuleType("gateway.platforms")
    base = types.ModuleType("gateway.platforms.base")
    base.BasePlatformAdapter = BasePlatformAdapter
    base.MessageEvent = MessageEvent
    base.MessageType = MessageType
    base.SendResult = SendResult
    session = types.ModuleType("gateway.session")
    session.build_session_key = build_session_key
    sys.modules.update(
        {
            "gateway": gateway,
            "gateway.config": config,
            "gateway.platforms": platforms,
            "gateway.platforms.base": base,
            "gateway.session": session,
        }
    )


def load_plugin_modules():
    install_fake_hermes_modules()
    package = types.ModuleType(PACKAGE)
    package.__path__ = [str(ROOT)]
    sys.modules[PACKAGE] = package
    for name in ("protocol", "connection", "cli", "adapter"):
        spec = importlib.util.spec_from_file_location(
            f"{PACKAGE}.{name}", ROOT / f"{name}.py"
        )
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[f"{PACKAGE}.{name}"] = module
        spec.loader.exec_module(module)
    return sys.modules[f"{PACKAGE}.adapter"]


adapter_module = load_plugin_modules()
protocol_module = sys.modules[f"{PACKAGE}.protocol"]


@contextlib.contextmanager
def hermes_without_describe_surfaces():
    """Model an older Hermes: the modules import, the accessors are absent."""
    names = ("hermes_cli", "hermes_cli.config", "tools", "tools.skills_tool")
    saved = {name: sys.modules.get(name) for name in names}
    hermes_cli = types.ModuleType("hermes_cli")
    hermes_cli.__path__ = []
    config = types.ModuleType("hermes_cli.config")
    tools = types.ModuleType("tools")
    tools.__path__ = []
    skills_tool = types.ModuleType("tools.skills_tool")
    sys.modules.update(
        {
            "hermes_cli": hermes_cli,
            "hermes_cli.config": config,
            "tools": tools,
            "tools.skills_tool": skills_tool,
        }
    )
    try:
        yield
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


class FakeConnection:
    def __init__(self):
        self.connected = True
        self.messages = []

    async def send(self, message):
        self.messages.append(message)


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.adapter = adapter_module.T3PlatformAdapter(
            PlatformConfig(
                extra={
                    "url": "wss://t3.example/api/hermes-gateway/ws",
                    "instance_id": "instance",
                    "credential": "credential",
                }
            )
        )
        self.connection = FakeConnection()
        self.adapter._connection = self.connection

    async def _start_turn(self, thread_id: str, turn_id: str):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": 2,
                "requestId": f"ensure-{thread_id}",
                "threadId": thread_id,
            }
        )
        session_id = self.adapter._sessions[thread_id]
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": 2,
                "requestId": f"start-{thread_id}",
                "threadId": thread_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "text": "Start",
            }
        )
        return session_id

    async def test_thread_ensure_start_stream_and_complete(self):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": 2,
                "requestId": "ensure-1",
                "threadId": "thread-1",
            }
        )
        ready = self.connection.messages[-2]
        self.assertEqual(ready["type"], "session.ready")
        self.assertEqual(ready["sessionId"], "agent:main:t3:dm:thread-1")
        self.assertEqual(self.connection.messages[-1]["activeSessionCount"], 1)

        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": 2,
                "requestId": "start-1",
                "threadId": "thread-1",
                "sessionId": ready["sessionId"],
                "turnId": "turn-1",
                "text": "Hello Hermes",
            }
        )
        self.assertEqual(self.adapter.messages[-1].text, "Hello Hermes")
        await self.adapter.send("thread-1", "Hello", metadata={"expect_edits": True})
        await self.adapter.edit_message(
            "thread-1", "message", "Hello world", finalize=True
        )
        types_seen = [message["type"] for message in self.connection.messages]
        self.assertIn("content.delta", types_seen)
        self.assertIn("turn.completed", types_seen)
        deltas = [
            message["delta"]
            for message in self.connection.messages
            if message["type"] == "content.delta"
        ]
        self.assertEqual(deltas, ["Hello", " world"])

    async def test_cumulative_edits_emit_delta_snapshot_delta_then_finalize(self):
        await self._start_turn("thread-snapshot", "turn-snapshot")
        content_start = len(self.connection.messages)

        await self.adapter.send("thread-snapshot", "Hello")
        duplicate_start = len(self.connection.messages)
        await self.adapter.edit_message("thread-snapshot", "message", "Hello")
        self.assertEqual(len(self.connection.messages), duplicate_start)

        await self.adapter.edit_message("thread-snapshot", "message", "Help")
        snapshot_duplicate_start = len(self.connection.messages)
        await self.adapter.edit_message("thread-snapshot", "message", "Help")
        self.assertEqual(len(self.connection.messages), snapshot_duplicate_start)

        await self.adapter.edit_message(
            "thread-snapshot",
            "message",
            "Helpful",
            finalize=True,
        )

        content_frames = self.connection.messages[content_start:]
        self.assertEqual(
            [message["type"] for message in content_frames],
            [
                "item.started",
                "content.delta",
                "content.snapshot",
                "content.delta",
                "item.completed",
                "turn.completed",
                "connection.status",
            ],
        )
        self.assertEqual(content_frames[1]["delta"], "Hello")
        self.assertEqual(content_frames[2]["text"], "Help")
        self.assertEqual(content_frames[3]["delta"], "ful")

    async def test_empty_and_duplicate_cumulative_edits_are_reconciled(self):
        await self._start_turn("thread-empty", "turn-empty")
        content_start = len(self.connection.messages)

        await self.adapter.send("thread-empty", "")
        duplicate_start = len(self.connection.messages)
        await self.adapter.edit_message("thread-empty", "message", "")
        self.assertEqual(len(self.connection.messages), duplicate_start)

        await self.adapter.edit_message("thread-empty", "message", "Visible")
        await self.adapter.edit_message("thread-empty", "message", "")
        empty_snapshot_end = len(self.connection.messages)
        await self.adapter.edit_message("thread-empty", "message", "")
        self.assertEqual(len(self.connection.messages), empty_snapshot_end)
        await self.adapter.edit_message(
            "thread-empty",
            "message",
            "",
            finalize=True,
        )

        content_frames = self.connection.messages[content_start:]
        self.assertEqual(
            [message["type"] for message in content_frames],
            [
                "item.started",
                "content.delta",
                "content.snapshot",
                "item.completed",
                "turn.completed",
                "connection.status",
            ],
        )
        self.assertEqual(content_frames[1]["delta"], "Visible")
        self.assertEqual(content_frames[2]["text"], "")

    async def test_failed_content_sends_do_not_advance_visible_text(self):
        await self._start_turn("thread-retry", "turn-retry")
        await self.adapter.send("thread-retry", "Hello")
        original_send = self.connection.send

        async def fail_content(message):
            if message["type"] in {"content.delta", "content.snapshot"}:
                raise ConnectionError("send failed")
            await original_send(message)

        self.connection.send = fail_content
        failed = await self.adapter.edit_message(
            "thread-retry",
            "message",
            "Hello world",
        )
        self.assertFalse(failed.success)
        self.assertEqual(
            self.adapter._active_turns["thread-retry"].visible_text,
            "Hello",
        )

        self.connection.send = original_send
        retried = await self.adapter.edit_message(
            "thread-retry",
            "message",
            "Hello world",
        )
        self.assertTrue(retried.success)
        self.assertEqual(self.connection.messages[-1]["delta"], " world")

        self.connection.send = fail_content
        failed_snapshot = await self.adapter.edit_message(
            "thread-retry",
            "message",
            "Hi",
        )
        self.assertFalse(failed_snapshot.success)
        self.assertEqual(
            self.adapter._active_turns["thread-retry"].visible_text,
            "Hello world",
        )

        self.connection.send = original_send
        retried_snapshot = await self.adapter.edit_message(
            "thread-retry",
            "message",
            "Hi",
        )
        self.assertTrue(retried_snapshot.success)
        self.assertEqual(self.connection.messages[-1]["type"], "content.snapshot")
        self.assertEqual(self.connection.messages[-1]["text"], "Hi")

    async def test_failed_generic_activity_start_retries_the_full_lifecycle(self):
        await self._start_turn("thread-activity-retry", "turn-activity-retry")
        turn = self.adapter._active_turns["thread-activity-retry"]
        original_send = self.connection.send

        async def fail_activity_start(message):
            if message["type"] == "item.started":
                raise ConnectionError("send failed")
            await original_send(message)

        self.connection.send = fail_activity_start
        with self.assertRaisesRegex(ConnectionError, "send failed"):
            await self.adapter._emit_generic_activity(turn, "Reading repository")

        self.assertIsNone(turn.generic_activity_id)
        self.assertIsNone(turn.generic_activity_detail)

        self.connection.send = original_send
        await self.adapter._emit_generic_activity(turn, "Reading repository")
        started = self.connection.messages[-1]
        self.assertEqual(started["type"], "item.started")
        self.assertEqual(started["detail"], "Reading repository")
        self.assertEqual(turn.generic_activity_id, started["itemId"])
        self.assertEqual(turn.generic_activity_detail, "Reading repository")

        await self.adapter._emit_generic_activity(turn, "Running tests")
        updated = self.connection.messages[-1]
        self.assertEqual(updated["type"], "item.updated")
        self.assertEqual(updated["itemId"], started["itemId"])
        self.assertEqual(updated["detail"], "Running tests")

    async def test_live_status_uses_status_text_not_the_unknown_sentinel(self):
        await self._start_turn("thread-status-type", "turn-status-type")
        turn = self.adapter._active_turns["thread-status-type"]

        await self.adapter._emit_generic_activity(turn, "Reading repository")
        await self.adapter._emit_generic_activity(turn, "Running tests")
        await self.adapter._complete_turn(turn)

        status_frames = [
            message
            for message in self.connection.messages
            if message.get("itemId") == turn.generic_activity_id
        ]
        self.assertEqual(
            [message["type"] for message in status_frames],
            ["item.started", "item.updated", "item.completed"],
        )
        # `unknown` is the canonical "could not classify" sentinel other
        # adapters rely on being inert; status lines get their own type.
        self.assertEqual(
            {message["itemType"] for message in status_frames},
            {"status_text"},
        )
        # T3 renders these rows preferring `detail`, so the real status string
        # must ride there rather than only in `title`.
        self.assertEqual(status_frames[0]["detail"], "Reading repository")
        self.assertEqual(status_frames[1]["detail"], "Running tests")
        self.assertEqual(status_frames[2]["detail"], "Running tests")

    async def test_concurrent_generic_activity_updates_share_one_lifecycle(self):
        await self._start_turn("thread-activity-concurrent", "turn-activity-concurrent")
        turn = self.adapter._active_turns["thread-activity-concurrent"]
        original_send = self.connection.send
        first_send_started = asyncio.Event()
        release_first_send = asyncio.Event()

        async def block_first_activity_send(message):
            if message["type"] == "item.started" and not first_send_started.is_set():
                first_send_started.set()
                await release_first_send.wait()
            await original_send(message)

        self.connection.send = block_first_activity_send
        first_update = asyncio.create_task(
            self.adapter._emit_generic_activity(turn, "Reading repository")
        )
        await first_send_started.wait()
        second_update = asyncio.create_task(
            self.adapter._emit_generic_activity(turn, "Running tests")
        )
        await asyncio.sleep(0)
        release_first_send.set()
        await asyncio.gather(first_update, second_update)

        activity_frames = [
            message
            for message in self.connection.messages
            if message["type"] in {"item.started", "item.updated"}
        ]
        self.assertEqual(
            [message["type"] for message in activity_frames],
            ["item.started", "item.updated"],
        )
        self.assertEqual(activity_frames[0]["itemId"], activity_frames[1]["itemId"])
        self.assertEqual(turn.generic_activity_id, activity_frames[0]["itemId"])
        self.assertEqual(turn.generic_activity_detail, "Running tests")

    async def test_turn_completion_waits_for_in_flight_generic_activity_update(self):
        await self._start_turn("thread-activity-complete", "turn-activity-complete")
        turn = self.adapter._active_turns["thread-activity-complete"]
        await self.adapter._emit_generic_activity(turn, "Reading repository")
        activity_id = turn.generic_activity_id
        original_send = self.connection.send
        update_send_started = asyncio.Event()
        release_update_send = asyncio.Event()

        async def block_activity_update(message):
            if message["type"] == "item.updated":
                update_send_started.set()
                await release_update_send.wait()
            await original_send(message)

        self.connection.send = block_activity_update
        in_flight_update = asyncio.create_task(
            self.adapter._emit_generic_activity(turn, "Running tests")
        )
        await update_send_started.wait()
        completion = asyncio.create_task(self.adapter._complete_turn(turn))
        await asyncio.sleep(0)
        self.assertFalse(completion.done())

        release_update_send.set()
        await asyncio.gather(in_flight_update, completion)

        lifecycle_frames = [
            message
            for message in self.connection.messages
            if message["type"]
            in {"item.started", "item.updated", "item.completed", "turn.completed"}
        ]
        self.assertEqual(
            [message["type"] for message in lifecycle_frames],
            ["item.started", "item.updated", "item.completed", "turn.completed"],
        )
        self.assertTrue(
            all(
                message["itemId"] == activity_id
                for message in lifecycle_frames
                if message["type"].startswith("item.")
            )
        )
        self.assertNotIn("thread-activity-complete", self.adapter._active_turns)

    def test_home_channel_notice_literal_matches_hermes_construction(self):
        # Hermes builds this notice inline from an f-string rather than
        # exporting a constant (gateway/run.py:13780 at upstream 62e07223), and
        # the adapter suppresses it by exact string equality. Reconstruct it the
        # same way so upstream wording drift fails here loudly instead of
        # leaking the notice into a T3 transcript.
        platform_name = "t3"  # Platform("t3").value
        sethome_cmd = "/sethome"  # non-Slack branch
        expected = (
            f"📬 No home channel is set for {platform_name.title()}. "
            f"A home channel is where Hermes delivers cron job results "
            f"and cross-platform messages.\n\n"
            f"Type {sethome_cmd} to make this chat your home channel, "
            f"or ignore to skip."
        )
        self.assertEqual(adapter_module._T3_HOME_CHANNEL_NOTICE, expected)

    async def test_exact_t3_home_channel_notice_is_suppressed(self):
        await self._start_turn("thread-notice", "turn-notice")
        content_start = len(self.connection.messages)
        notice = (
            "📬 No home channel is set for T3. "
            "A home channel is where Hermes delivers cron job results "
            "and cross-platform messages.\n\n"
            "Type /sethome to make this chat your home channel, or ignore to skip."
        )

        suppressed = await self.adapter.send("thread-notice", notice)
        self.assertTrue(suppressed.success)
        self.assertEqual(len(self.connection.messages), content_start)
        self.assertFalse(
            self.adapter._active_turns["thread-notice"].assistant_started
        )

        await self.adapter.edit_message(
            "thread-notice",
            "message",
            "The actual Hermes response",
            finalize=True,
        )
        content_frames = self.connection.messages[content_start:]
        self.assertEqual(
            [message["type"] for message in content_frames],
            [
                "item.started",
                "content.delta",
                "item.completed",
                "turn.completed",
                "connection.status",
            ],
        )
        self.assertEqual(content_frames[1]["delta"], "The actual Hermes response")

    async def test_terminal_send_suppresses_exact_home_notice_and_completes_turn(self):
        await self._start_turn("thread-terminal-notice-send", "turn-terminal-notice-send")
        content_start = len(self.connection.messages)
        notice = (
            "📬 No home channel is set for T3. "
            "A home channel is where Hermes delivers cron job results "
            "and cross-platform messages.\n\n"
            "Type /sethome to make this chat your home channel, or ignore to skip."
        )

        suppressed = await self.adapter.send(
            "thread-terminal-notice-send",
            notice,
            metadata={"notify": True},
        )

        self.assertTrue(suppressed.success)
        self.assertNotIn("thread-terminal-notice-send", self.adapter._active_turns)
        self.assertEqual(
            [
                message["type"]
                for message in self.connection.messages[content_start:]
            ],
            ["turn.completed", "connection.status"],
        )

    async def test_terminal_edit_suppresses_exact_home_notice_and_completes_turn(self):
        await self._start_turn("thread-terminal-notice-edit", "turn-terminal-notice-edit")
        content_start = len(self.connection.messages)
        notice = (
            "📬 No home channel is set for T3. "
            "A home channel is where Hermes delivers cron job results "
            "and cross-platform messages.\n\n"
            "Type /sethome to make this chat your home channel, or ignore to skip."
        )

        suppressed = await self.adapter.edit_message(
            "thread-terminal-notice-edit",
            "message",
            notice,
            finalize=True,
        )

        self.assertTrue(suppressed.success)
        self.assertNotIn("thread-terminal-notice-edit", self.adapter._active_turns)
        self.assertEqual(
            [
                message["type"]
                for message in self.connection.messages[content_start:]
            ],
            ["turn.completed", "connection.status"],
        )

    async def test_near_match_home_channel_text_is_not_suppressed(self):
        await self._start_turn("thread-notice-near-match", "turn-notice-near-match")
        content_start = len(self.connection.messages)
        await self.adapter.edit_message(
            "thread-notice-near-match",
            "message",
            (
                "📬 No home channel is set for T3. "
                "A home channel is where Hermes delivers cron job results "
                "and cross-platform messages.\n\n"
                "Type /sethome to make this chat your home channel, "
                "or ignore to skip. "
            ),
            finalize=True,
        )
        self.assertEqual(
            [
                message["type"]
                for message in self.connection.messages[content_start:]
            ],
            [
                "item.started",
                "content.delta",
                "item.completed",
                "turn.completed",
                "connection.status",
            ],
        )

    async def test_session_ready_reports_an_active_turn_on_reconnect(self):
        session_id = await self._start_turn("thread-reconnect", "turn-reconnect")

        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": 2,
                "requestId": "ensure-reconnect",
                "threadId": "thread-reconnect",
                "resumeSessionId": session_id,
            }
        )

        ready = self.connection.messages[-2]
        self.assertEqual(ready["type"], "session.ready")
        self.assertTrue(ready["resumed"])
        self.assertEqual(ready["activeTurnId"], "turn-reconnect")

    async def test_steer_uses_official_hermes_command(self):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": 2,
                "requestId": "ensure-2",
                "threadId": "thread-2",
            }
        )
        session_id = self.adapter._sessions["thread-2"]
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": 2,
                "requestId": "start-2",
                "threadId": "thread-2",
                "sessionId": session_id,
                "turnId": "turn-2",
                "text": "Start",
            }
        )
        messages_before_steer = len(self.connection.messages)

        async def accept_steer(_event):
            return (
                "⏩ Steer queued — arrives after the next tool call: 'Focus on tests'"
            )

        self.adapter._message_handler = accept_steer
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": 2,
                "requestId": "steer-2",
                "threadId": "thread-2",
                "sessionId": session_id,
                "turnId": "turn-2",
                "text": "Focus on tests",
            }
        )
        self.assertEqual(self.adapter.messages[-1].text, "/steer Focus on tests")
        self.assertEqual(self.adapter.messages[-1].message_type, MessageType.COMMAND)
        steer_messages = self.connection.messages[messages_before_steer:]
        self.assertEqual(
            [message["type"] for message in steer_messages], ["turn.started"]
        )
        self.assertEqual(steer_messages[0]["requestId"], "steer-2")
        self.assertIn("thread-2", self.adapter._active_turns)

        await self.adapter.edit_message(
            "thread-2",
            "message",
            "Actual response after steering",
            finalize=True,
        )
        deltas = [
            message["delta"]
            for message in self.connection.messages
            if message["type"] == "content.delta"
        ]
        self.assertEqual(deltas, ["Actual response after steering"])
        self.assertNotIn("thread-2", self.adapter._active_turns)

    async def test_assistant_output_during_a_steer_is_not_captured_as_control(self):
        session_id = await self._start_turn("thread-steer-race", "turn-steer-race")
        messages_before_steer = len(self.connection.messages)

        async def stream_while_steering(event):
            # A steer targets a RUNNING turn, so Hermes can emit genuine
            # assistant output on this same thread while the steering command
            # is still being awaited. That output must reach the transcript.
            await self.adapter.edit_message(
                "thread-steer-race",
                "hermes-stream-message",
                "Mid-steer assistant output",
            )
            del event
            return "⏩ Steer queued — arrives after the next tool call: 'Focus'"

        self.adapter._message_handler = stream_while_steering
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": 2,
                "requestId": "steer-race",
                "threadId": "thread-steer-race",
                "sessionId": session_id,
                "turnId": "turn-steer-race",
                "text": "Focus",
            }
        )

        steer_messages = self.connection.messages[messages_before_steer:]
        self.assertEqual(
            [message["type"] for message in steer_messages],
            ["item.started", "content.delta", "turn.started"],
        )
        self.assertEqual(steer_messages[1]["delta"], "Mid-steer assistant output")
        # The acknowledgement itself is still captured and suppressed, so the
        # steer is acknowledged rather than failing closed on the prefix check.
        self.assertEqual(steer_messages[2]["requestId"], "steer-race")
        self.assertIn("thread-steer-race", self.adapter._active_turns)
        self.assertEqual(
            self.adapter._active_turns["thread-steer-race"].visible_text,
            "Mid-steer assistant output",
        )

    async def test_steer_control_acknowledgement_edits_stay_suppressed(self):
        session_id = await self._start_turn("thread-steer-edit", "turn-steer-edit")
        messages_before_steer = len(self.connection.messages)
        acknowledgement = "⏩ Steer queued — arrives after the next tool call: 'Focus'"

        async def edit_own_acknowledgement(event):
            sent = await self.adapter.send(
                "thread-steer-edit",
                acknowledgement,
                reply_to=event.message_id,
                metadata={"notify": True},
            )
            # A retry/finalize edit of the control message correlates by the
            # synthetic control message id, so it stays out of the transcript.
            await self.adapter.edit_message(
                "thread-steer-edit",
                sent.message_id,
                acknowledgement,
                finalize=True,
            )

        self.adapter._message_handler = edit_own_acknowledgement
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": 2,
                "requestId": "steer-edit",
                "threadId": "thread-steer-edit",
                "sessionId": session_id,
                "turnId": "turn-steer-edit",
                "text": "Focus",
            }
        )

        steer_messages = self.connection.messages[messages_before_steer:]
        self.assertEqual(
            [message["type"] for message in steer_messages], ["turn.started"]
        )
        self.assertIn("thread-steer-edit", self.adapter._active_turns)

    async def test_rejected_steer_emits_error_without_completing_active_turn(self):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": 2,
                "requestId": "ensure-rejected-steer",
                "threadId": "thread-rejected-steer",
            }
        )
        session_id = self.adapter._sessions["thread-rejected-steer"]
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": 2,
                "requestId": "start-rejected-steer",
                "threadId": "thread-rejected-steer",
                "sessionId": session_id,
                "turnId": "turn-rejected-steer",
                "text": "Start",
            }
        )
        messages_before_steer = len(self.connection.messages)

        async def reject_steer(_event):
            return "Steer rejected (empty payload)."

        self.adapter._message_handler = reject_steer
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": 2,
                "requestId": "steer-rejected",
                "threadId": "thread-rejected-steer",
                "sessionId": session_id,
                "turnId": "turn-rejected-steer",
                "text": "Focus on tests",
            }
        )

        steer_messages = self.connection.messages[messages_before_steer:]
        self.assertEqual(
            [message["type"] for message in steer_messages], ["protocol.error"]
        )
        self.assertEqual(steer_messages[0]["requestId"], "steer-rejected")
        self.assertEqual(steer_messages[0]["code"], "invalid-message")
        self.assertIn("thread-rejected-steer", self.adapter._active_turns)

        await self.adapter.edit_message(
            "thread-rejected-steer",
            "message",
            "Actual response after rejected steering",
            finalize=True,
        )
        self.assertEqual(self.connection.messages[-1]["type"], "connection.status")
        self.assertNotIn("thread-rejected-steer", self.adapter._active_turns)

    async def test_failed_steer_emits_correlated_internal_error(self):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": 2,
                "requestId": "ensure-failed-steer",
                "threadId": "thread-failed-steer",
            }
        )
        session_id = self.adapter._sessions["thread-failed-steer"]
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": 2,
                "requestId": "start-failed-steer",
                "threadId": "thread-failed-steer",
                "sessionId": session_id,
                "turnId": "turn-failed-steer",
                "text": "Start",
            }
        )
        messages_before_steer = len(self.connection.messages)

        async def fail_steer(_event):
            raise RuntimeError("running agent rejected steering")

        self.adapter._message_handler = fail_steer
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": 2,
                "requestId": "steer-failed",
                "threadId": "thread-failed-steer",
                "sessionId": session_id,
                "turnId": "turn-failed-steer",
                "text": "Focus on tests",
            }
        )

        steer_messages = self.connection.messages[messages_before_steer:]
        self.assertEqual(
            [message["type"] for message in steer_messages], ["protocol.error"]
        )
        self.assertEqual(steer_messages[0]["requestId"], "steer-failed")
        self.assertEqual(steer_messages[0]["code"], "internal-error")
        self.assertIn("thread-failed-steer", self.adapter._active_turns)

    async def test_schedule_keeps_a_strong_reference_until_the_task_finishes(self):
        self.adapter._event_loop = asyncio.get_running_loop()
        released = asyncio.Event()

        async def work():
            await asyncio.sleep(0)
            released.set()

        self.adapter._schedule(work())
        self.assertEqual(len(self.adapter._scheduled_tasks), 1)
        await released.wait()
        await asyncio.sleep(0)
        self.assertEqual(self.adapter._scheduled_tasks, set())

    async def test_schedule_logs_background_task_failures(self):
        self.adapter._event_loop = asyncio.get_running_loop()

        async def boom():
            raise RuntimeError("background frame failed")

        with self.assertLogs(adapter_module.logger, level="ERROR") as captured:
            self.adapter._schedule(boom())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        self.assertTrue(
            any("background frame failed" in line for line in captured.output)
        )
        self.assertEqual(self.adapter._scheduled_tasks, set())

    async def test_schedule_does_not_create_tasks_on_a_foreign_loop(self):
        other_loop = asyncio.new_event_loop()
        self.adapter._event_loop = other_loop

        async def work():
            return None

        coroutine = work()
        try:
            with (
                unittest.mock.patch.object(other_loop, "create_task") as create_task,
                unittest.mock.patch.object(
                    adapter_module.asyncio, "run_coroutine_threadsafe"
                ) as threadsafe,
            ):
                # The running loop is this test's loop, not the adapter's, so
                # create_task would schedule onto the wrong loop entirely.
                self.adapter._schedule(coroutine)
            create_task.assert_not_called()
            threadsafe.assert_called_once_with(coroutine, other_loop)
            self.assertEqual(self.adapter._scheduled_tasks, set())
        finally:
            coroutine.close()
            other_loop.close()

    async def test_schedule_closes_the_coroutine_when_the_loop_is_gone(self):
        self.adapter._event_loop = None
        started = False

        async def work():
            nonlocal started
            started = True

        coroutine = work()
        self.adapter._schedule(coroutine)
        self.assertFalse(started)
        self.assertEqual(self.adapter._scheduled_tasks, set())

    async def test_session_status_counts_ready_sessions_and_stop_decrements(self):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": 2,
                "requestId": "ensure-3",
                "threadId": "thread-3",
            }
        )
        session_id = self.adapter._sessions["thread-3"]
        self.assertEqual(self.connection.messages[-1]["activeSessionCount"], 1)
        await self.adapter._handle_server_frame(
            {
                "type": "session.stop",
                "protocolVersion": 2,
                "requestId": "stop-3",
                "threadId": "thread-3",
                "sessionId": session_id,
            }
        )
        self.assertEqual(self.connection.messages[-1]["type"], "connection.status")
        self.assertEqual(self.connection.messages[-1]["activeSessionCount"], 0)
        self.assertEqual(self.adapter._sessions["thread-3"], session_id)

    async def test_describe_request_replies_with_the_requests_own_id(self):
        with unittest.mock.patch.object(
            adapter_module, "_hermes_version", return_value="0.19.0"
        ), unittest.mock.patch.object(
            adapter_module,
            "describe_response",
            wraps=adapter_module.describe_response,
        ) as describe:
            await self.adapter._handle_server_frame(
                {
                    "type": "describe.request",
                    "protocolVersion": 2,
                    "requestId": "describe-1",
                }
            )

        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "describe.response")
        # Correlation, exactly like ping -> pong.
        self.assertEqual(reply["requestId"], "describe-1")
        self.assertEqual(reply["protocolVersion"], 2)
        self.assertEqual(reply["hermesVersion"], "0.19.0")
        self.assertIsInstance(reply["skills"], list)
        self.assertIn("capabilities", reply)
        self.assertEqual(describe.call_count, 1)

    async def test_describe_request_survives_hermes_being_unreadable(self):
        # An older Hermes whose modules exist but export none of the accessors
        # the plugin reads. The reply gets thinner; it never becomes an error
        # and never breaks the connection.
        with hermes_without_describe_surfaces():
            await self.adapter._handle_server_frame(
                {
                    "type": "describe.request",
                    "protocolVersion": 2,
                    "requestId": "describe-degraded",
                }
            )
        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "describe.response")
        self.assertEqual(reply["requestId"], "describe-degraded")
        self.assertNotIn("reasoningEffort", reply)
        self.assertNotIn("model", reply)
        self.assertEqual(reply["skills"], [])
        self.assertEqual(reply["pluginVersion"], protocol_module.PLUGIN_VERSION)

    async def test_skill_body_request_survives_hermes_being_unreadable(self):
        with hermes_without_describe_surfaces():
            await self.adapter._handle_server_frame(
                {
                    "type": "skill.body.request",
                    "protocolVersion": 2,
                    "requestId": "body-degraded",
                    "skillName": "codex",
                }
            )
        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "skill.body.response")
        self.assertEqual(reply["requestId"], "body-degraded")
        self.assertEqual(reply["skillName"], "codex")
        self.assertIsNone(reply["markdown"])

    async def test_skill_body_request_replies_with_correlated_markdown(self):
        with unittest.mock.patch.object(
            adapter_module, "skill_body", return_value="# Codex\n"
        ) as read_body:
            await self.adapter._handle_server_frame(
                {
                    "type": "skill.body.request",
                    "protocolVersion": 2,
                    "requestId": "body-1",
                    "skillName": "codex",
                }
            )

        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "skill.body.response")
        self.assertEqual(reply["requestId"], "body-1")
        self.assertEqual(reply["skillName"], "codex")
        self.assertEqual(reply["markdown"], "# Codex\n")
        read_body.assert_called_once_with("codex")

    async def test_skill_body_request_replies_null_for_an_unknown_skill(self):
        await self.adapter._handle_server_frame(
            {
                "type": "skill.body.request",
                "protocolVersion": 2,
                "requestId": "body-2",
                "skillName": "does-not-exist",
            }
        )
        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "skill.body.response")
        self.assertEqual(reply["requestId"], "body-2")
        self.assertEqual(reply["skillName"], "does-not-exist")
        # Present but null, not an error the UI would have to render.
        self.assertIn("markdown", reply)
        self.assertIsNone(reply["markdown"])

    async def test_skill_body_request_without_a_name_is_a_correlated_error(self):
        # `skillName` is echoed back for the client to key on and is non-empty
        # on the wire, so a nameless request cannot be answered with a
        # response frame — it takes the ordinary protocol.error path.
        await self.adapter._handle_server_frame(
            {
                "type": "skill.body.request",
                "protocolVersion": 2,
                "requestId": "body-3",
            }
        )
        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "protocol.error")
        self.assertEqual(reply["requestId"], "body-3")
        self.assertEqual(reply["code"], "unsupported-message")
        self.assertTrue(reply["recoverable"])

    async def test_describe_frames_never_emit_a_protocol_error(self):
        for message in (
            {
                "type": "describe.request",
                "protocolVersion": 2,
                "requestId": "describe-no-error",
            },
            {
                "type": "skill.body.request",
                "protocolVersion": 2,
                "requestId": "body-no-error",
                "skillName": "codex",
            },
        ):
            with self.subTest(frame_type=message["type"]):
                await self.adapter._handle_server_frame(message)
        self.assertNotIn(
            "protocol.error",
            [message["type"] for message in self.connection.messages],
        )

    def test_tool_progress_chrome_is_dropped(self):
        """Tool chrome must never reach T3 as a user-visible reply.

        The gateway marks user-visible replies `notify=True`, and `send()`
        treats `notify` as "turn finished". Rendering tool chrome therefore
        ended the T3 turn on the first tool call, and everything Hermes did
        afterwards failed with "no active T3 turn". T3 already renders tool
        calls as typed activity items, so the text is redundant regardless.
        """

        class _ToolCallChunk:
            tool_name = "skill_view"
            preview = "hermes-agent"
            args = {"name": "hermes-agent"}

        for mode in ("all", "new", "verbose"):
            with self.subTest(mode=mode):
                self.assertIsNone(
                    self.adapter.format_tool_event(_ToolCallChunk(), mode=mode)
                )


if __name__ == "__main__":
    unittest.main()
