from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import types
import unittest
from contextlib import contextmanager

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "t3_gateway_protocol", ROOT / "protocol.py"
)
assert SPEC and SPEC.loader
protocol = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(protocol)


@contextmanager
def fake_hermes_config(loader):
    """Install a stand-in `hermes_cli.config` for the duration of a test."""
    saved = {
        name: sys.modules.get(name) for name in ("hermes_cli", "hermes_cli.config")
    }
    package = types.ModuleType("hermes_cli")
    package.__path__ = []
    config = types.ModuleType("hermes_cli.config")
    if loader is not None:
        config.load_config_readonly = loader
    package.config = config
    sys.modules["hermes_cli"] = package
    sys.modules["hermes_cli.config"] = config
    try:
        yield
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


@contextmanager
def fake_hermes_skills(skills_list=None, skill_view=None):
    """Install a stand-in `tools.skills_tool` for the duration of a test."""
    saved = {name: sys.modules.get(name) for name in ("tools", "tools.skills_tool")}
    package = types.ModuleType("tools")
    package.__path__ = []
    skills_tool = types.ModuleType("tools.skills_tool")
    if skills_list is not None:
        skills_tool.skills_list = skills_list
    if skill_view is not None:
        skills_tool.skill_view = skill_view
    package.skills_tool = skills_tool
    sys.modules["tools"] = package
    sys.modules["tools.skills_tool"] = skills_tool
    try:
        yield
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


class ProtocolTests(unittest.TestCase):
    def test_hello_matches_v3_contract(self):
        hello = protocol.connection_hello(
            hermes_version="0.19.0",
            authentication={"type": "enrollment-token", "token": "once"},
            hello_request_id="request-1",
            model="gpt-5.6-terra",
        )
        self.assertEqual(hello["type"], "connection.hello")
        self.assertEqual(hello["requestId"], "request-1")
        self.assertEqual(hello["protocolVersion"], 3)
        self.assertFalse(hello["capabilities"]["attachments"])
        self.assertTrue(hello["capabilities"]["streaming"])
        self.assertEqual(hello["model"], "gpt-5.6-terra")

    def test_hello_reports_the_configured_hermes_model(self):
        config = {"model": {"default": "gpt-5.6-terra"}}

        with fake_hermes_config(lambda: config):
            hello = protocol.connection_hello(
                hermes_version="0.19.0",
                authentication={"type": "enrollment-token", "token": "once"},
            )

        self.assertEqual(hello["model"], "gpt-5.6-terra")
        # `load_config_readonly` returns the shared process-wide cache; the
        # lookup must never mutate it.
        self.assertEqual(config, {"model": {"default": "gpt-5.6-terra"}})

    def test_hello_omits_model_when_hermes_cannot_report_one(self):
        def missing_section():
            return {"agent": {}}

        def older_hermes():
            raise ImportError("load_config_readonly is unavailable")

        for loader in (missing_section, older_hermes, None):
            with self.subTest(loader=getattr(loader, "__name__", "absent")):
                with fake_hermes_config(loader):
                    hello = protocol.connection_hello(
                        hermes_version="0.19.0",
                        authentication={
                            "type": "enrollment-token",
                            "token": "once",
                        },
                    )
                # Omitted entirely — never null or empty.
                self.assertNotIn("model", hello)

    def test_configured_model_ignores_blank_and_non_string_values(self):
        for value in ("", "   ", None, 5, {"default": "nested"}):
            config = {"model": {"default": value}}
            with (
                self.subTest(value=value),
                fake_hermes_config(lambda config=config: config),
            ):
                self.assertIsNone(protocol.configured_model())

    def test_server_frame_validation_is_closed(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            protocol.validate_server_frame({"type": "made.up", "protocolVersion": 3})
        with self.assertRaisesRegex(ValueError, "version"):
            # Protocol v2 peers must upgrade before sending runtime frames.
            protocol.validate_server_frame({"type": "ping", "protocolVersion": 2})

    def test_describe_frames_are_accepted_server_commands(self):
        for frame_type in ("describe.request", "skill.body.request"):
            with self.subTest(frame_type=frame_type):
                message = {"type": frame_type, "protocolVersion": 3}
                self.assertEqual(protocol.validate_server_frame(message), message)

    # ── describe.response ──────────────────────────────────────────────

    def test_describe_response_round_trips_every_reported_field(self):
        skills = [
            {"name": "codex", "description": "Delegate coding.", "source": "agents"}
        ]
        response = protocol.describe_response(
            request_id_value="describe-1",
            hermes_version="0.19.0",
            model="gpt-5.6-terra",
            reasoning_effort="medium",
            skills=skills,
        )
        self.assertEqual(response["type"], "describe.response")
        self.assertEqual(response["requestId"], "describe-1")
        self.assertEqual(response["protocolVersion"], 3)
        self.assertEqual(response["pluginVersion"], protocol.PLUGIN_VERSION)
        self.assertEqual(response["hermesVersion"], "0.19.0")
        self.assertEqual(response["model"], "gpt-5.6-terra")
        self.assertEqual(response["reasoningEffort"], "medium")
        self.assertEqual(response["skills"], skills)
        self.assertFalse(response["capabilities"]["attachments"])
        self.assertTrue(response["describedAt"].endswith("Z"))
        # Skill dicts are copied out: mutating the reply must not reach back
        # into whatever the caller passed in.
        response["skills"][0]["name"] = "mutated"
        self.assertEqual(skills[0]["name"], "codex")

    def test_describe_reports_the_configured_reasoning_effort(self):
        config = {"agent": {"reasoning_effort": "medium"}}

        with fake_hermes_config(lambda: config):
            response = protocol.describe_response(
                request_id_value="describe-2",
                hermes_version="0.19.0",
                skills=[],
            )

        self.assertEqual(response["reasoningEffort"], "medium")
        # `load_config_readonly` returns the shared process-wide cache; the
        # lookup must never mutate it.
        self.assertEqual(config, {"agent": {"reasoning_effort": "medium"}})

    def test_describe_omits_effort_when_hermes_cannot_report_one(self):
        def missing_section():
            return {"model": {}}

        def older_hermes():
            raise ImportError("load_config_readonly is unavailable")

        for loader in (missing_section, older_hermes, None):
            with self.subTest(loader=getattr(loader, "__name__", "absent")):
                with fake_hermes_config(loader):
                    response = protocol.describe_response(
                        request_id_value="describe-3",
                        hermes_version="0.19.0",
                        skills=[],
                    )
                # Omitted entirely — never null or empty.
                self.assertNotIn("reasoningEffort", response)
                self.assertNotIn("model", response)
                # The plugin-owned block is always present regardless.
                self.assertEqual(response["pluginVersion"], protocol.PLUGIN_VERSION)
                self.assertEqual(response["skills"], [])

    def test_configured_reasoning_effort_ignores_blank_and_non_string_values(self):
        for value in ("", "   ", None, 5, {"level": "high"}):
            config = {"agent": {"reasoning_effort": value}}
            with (
                self.subTest(value=value),
                fake_hermes_config(lambda config=config: config),
            ):
                self.assertIsNone(protocol.configured_reasoning_effort())

    # ── skills enumeration ─────────────────────────────────────────────

    def test_installed_skills_projects_only_documented_fields(self):
        payload = json.dumps(
            {
                "success": True,
                "skills": [
                    {
                        "name": "  codex  ",
                        "description": "  Delegate coding.  ",
                        "category": "autonomous-ai-agents",
                        "secret": "must-not-cross",
                    },
                    {"name": "bare"},
                ],
            }
        )
        with fake_hermes_skills(skills_list=lambda: payload):
            self.assertEqual(
                protocol.installed_skills(),
                [
                    {
                        "name": "codex",
                        "enabled": True,
                        "description": "Delegate coding.",
                        "source": "autonomous-ai-agents",
                    },
                    {"name": "bare", "enabled": True},
                ],
            )

    def test_installed_skills_degrades_to_empty_on_every_failure(self):
        def older_hermes():
            raise ImportError("skills_list is unavailable")

        def not_json():
            return "<html>not json</html>"

        def unsuccessful():
            return json.dumps({"success": False, "error": "boom"})

        def malformed_entries():
            return json.dumps({"success": True, "skills": ["a string", {}, 5]})

        for loader in (older_hermes, not_json, unsuccessful, malformed_entries, None):
            with self.subTest(loader=getattr(loader, "__name__", "absent")):
                with fake_hermes_skills(skills_list=loader):
                    self.assertEqual(protocol.installed_skills(), [])

    def test_describe_reports_an_empty_skill_list_when_hermes_has_none(self):
        with fake_hermes_skills(
            skills_list=lambda: json.dumps({"success": True, "skills": []})
        ):
            response = protocol.describe_response(
                request_id_value="describe-4",
                hermes_version="0.19.0",
                model="gpt-5.6-terra",
                reasoning_effort="medium",
            )
        # Always present: an empty list is the truthful answer, never omitted.
        self.assertEqual(response["skills"], [])

    # ── skill.body.response ────────────────────────────────────────────

    def test_skill_body_response_round_trips(self):
        response = protocol.skill_body_response(
            request_id_value="body-1",
            skill_name="codex",
            markdown="# Codex\n\nDelegate coding.",
        )
        self.assertEqual(response["type"], "skill.body.response")
        self.assertEqual(response["requestId"], "body-1")
        self.assertEqual(response["protocolVersion"], 3)
        self.assertEqual(response["skillName"], "codex")
        self.assertEqual(response["markdown"], "# Codex\n\nDelegate coding.")

    def test_skill_body_response_sends_explicit_null_when_unavailable(self):
        for markdown in (None, ""):
            with self.subTest(markdown=markdown):
                response = protocol.skill_body_response(
                    request_id_value="body-2",
                    skill_name="missing",
                    markdown=markdown,
                )
                # Present but null — the caller asked about a named skill and
                # must tell "nothing to show" from a dropped reply.
                self.assertIn("markdown", response)
                self.assertIsNone(response["markdown"])

    def test_skill_body_reads_the_authored_markdown_without_preprocessing(self):
        seen = {}

        def skill_view(name, preprocess=True, **kwargs):
            seen["name"] = name
            seen["preprocess"] = preprocess
            return json.dumps({"success": True, "content": "# Codex\n"})

        with fake_hermes_skills(skill_view=skill_view):
            self.assertEqual(protocol.skill_body("  codex  "), "# Codex\n")
        self.assertEqual(seen["name"], "codex")
        # T3 renders the skill for a human; Hermes' template/inline-shell
        # rendering must not run.
        self.assertFalse(seen["preprocess"])

    def test_skill_body_truncates_a_pathological_body(self):
        oversized = "x" * (protocol.MAX_SKILL_BODY_CHARS + 5_000)
        with fake_hermes_skills(
            skill_view=lambda *a, **kw: json.dumps(
                {"success": True, "content": oversized}
            )
        ):
            body = protocol.skill_body("huge")
        self.assertEqual(len(body), protocol.MAX_SKILL_BODY_CHARS)

    def test_skill_body_degrades_to_none_on_every_failure(self):
        def older_hermes(*a, **kw):
            raise ImportError("skill_view is unavailable")

        def not_json(*a, **kw):
            return "<html>not json</html>"

        def unknown_skill(*a, **kw):
            return json.dumps({"success": False, "error": "Skill 'x' not found."})

        def blank_content(*a, **kw):
            return json.dumps({"success": True, "content": "   "})

        for viewer in (older_hermes, not_json, unknown_skill, blank_content, None):
            with self.subTest(viewer=getattr(viewer, "__name__", "absent")):
                with fake_hermes_skills(skill_view=viewer):
                    self.assertIsNone(protocol.skill_body("codex"))

        # A blank request never reaches Hermes at all.
        with fake_hermes_skills(skill_view=older_hermes):
            self.assertIsNone(protocol.skill_body("   "))
            self.assertIsNone(protocol.skill_body(None))

    def test_tool_types_map_to_canonical_items(self):
        self.assertEqual(
            protocol.canonical_tool_item_type("terminal"), "command_execution"
        )
        self.assertEqual(
            protocol.canonical_tool_item_type("apply_patch"), "file_change"
        )
        self.assertEqual(
            protocol.canonical_tool_item_type("custom_vendor_tool"),
            "dynamic_tool_call",
        )

    def test_tool_data_never_forwards_arbitrary_args(self):
        self.assertEqual(
            protocol.canonical_tool_data(
                "terminal",
                {"command": "pytest", "cwd": "/repo", "credential": "secret"},
            ),
            {"command": "pytest", "cwd": "/repo"},
        )
        self.assertIsNone(
            protocol.canonical_tool_data(
                "custom_vendor_tool", {"credential": "must-not-cross"}
            )
        )


if __name__ == "__main__":
    unittest.main()
