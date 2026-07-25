from __future__ import annotations

import importlib.util
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


class ProtocolTests(unittest.TestCase):
    def test_hello_matches_v2_contract(self):
        hello = protocol.connection_hello(
            hermes_version="0.19.0",
            authentication={"type": "enrollment-token", "token": "once"},
            hello_request_id="request-1",
            model="gpt-5.6-terra",
        )
        self.assertEqual(hello["type"], "connection.hello")
        self.assertEqual(hello["requestId"], "request-1")
        self.assertEqual(hello["protocolVersion"], 2)
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
            protocol.validate_server_frame({"type": "made.up", "protocolVersion": 2})
        with self.assertRaisesRegex(ValueError, "version"):
            # Protocol v1 peers must upgrade before sending runtime frames.
            protocol.validate_server_frame({"type": "ping", "protocolVersion": 1})

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
