from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from hermes_cli import plugins as plugins_module
from hermes_cli.plugins import PluginManager


PLUGIN_SOURCE = Path(__file__).resolve().parents[1]


def isolated_manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, enabled: bool, disabled: bool = False) -> tuple[PluginManager, Path]:
    home = tmp_path / "profile"
    plugin_destination = home / "plugins" / "cmai-hermes"
    plugin_destination.parent.mkdir(parents=True)
    shutil.copytree(PLUGIN_SOURCE, plugin_destination)
    config = {
        "plugins": {
            "enabled": ["cmai-hermes"] if enabled else [],
            "disabled": ["cmai-hermes"] if disabled else [],
        }
    }
    home.mkdir(exist_ok=True)
    (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
    empty_bundled = tmp_path / "bundled"
    empty_bundled.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_ENABLE_PROJECT_PLUGINS", raising=False)
    monkeypatch.setattr(plugins_module, "get_bundled_plugins_dir", lambda: empty_bundled)
    manager = PluginManager()
    monkeypatch.setattr(manager, "_scan_entry_points", lambda: [])
    return manager, home


def valid_inference_request(inference) -> dict[str, object]:
    input_payload = {
        "request_class": "challenge_contribution",
        "prompt_version": "cmai_contribution_v1",
        "challenge": {
            "challenge_id": "challenge_1",
            "revision": 1,
            "run_grant": {
                "run_nonce": "n" * 43,
                "issued_at": "2099-01-01T00:00:00.000Z",
                "expires_at": "2099-01-01T00:05:00.000Z",
                "request_class": "challenge_contribution",
                "challenge_revision": 1,
                "prompt_version": "cmai_contribution_v1",
                "max_output_bytes": 65536,
            },
        },
    }
    return {
        "purpose": "cmai_challenge_contribution",
        "instructions": inference.INSTRUCTIONS,
        "inputText": json.dumps(input_payload, separators=(",", ":")),
        "jsonSchema": inference.load_fixed_schema(),
        "maxTokens": 4096,
        "temperature": 0.2,
        "timeoutSeconds": 45,
    }


def test_enabled_disposable_profile_registers_one_command_and_one_skill_without_lifecycle_process(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process_calls = []
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: process_calls.append((args, kwargs)))
    manager, home = isolated_manager(tmp_path, monkeypatch, enabled=True)

    manager.discover_and_load()

    loaded = manager._plugins["cmai-hermes"]
    assert loaded.enabled is True
    assert loaded.error is None
    assert set(manager._plugin_commands) == {"cmai"}
    assert set(manager._plugin_skills) == {"cmai-hermes:cmai-contribution"}
    assert loaded.tools_registered == []
    assert loaded.hooks_registered == []
    assert loaded.middleware_registered == []
    assert process_calls == []
    assert not (home / "state" / "cmai-hermes").exists()


def test_disabled_disposable_profile_registers_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, _home = isolated_manager(tmp_path, monkeypatch, enabled=True, disabled=True)

    manager.discover_and_load()

    loaded = manager._plugins["cmai-hermes"]
    assert loaded.enabled is False
    assert loaded.error == "disabled via config"
    assert "cmai" not in manager._plugin_commands
    assert "cmai-hermes:cmai-contribution" not in manager._plugin_skills


def test_registered_command_closes_over_host_llm_without_calling_it_at_registration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _home = isolated_manager(tmp_path, monkeypatch, enabled=True)
    manager.discover_and_load()
    loaded = manager._plugins["cmai-hermes"]
    observed: dict[str, object] = {}

    def fake_run(raw: str, **kwargs) -> str:
        observed.update({"raw": raw, **kwargs})
        return "safe-result"

    monkeypatch.setattr(loaded.module.bridge, "run_cmai_command", fake_run)
    handler = manager._plugin_commands["cmai"]["handler"]
    assert handler("status") == "safe-result"
    assert observed["raw"] == "status"
    assert observed["llm"] is None
    assert observed["profile_name"] == "default"

    assert handler("run challenge_1 confirm 1") == "safe-result"
    assert observed["raw"] == "run challenge_1 confirm 1"
    assert observed["llm"] is not None


def test_incompatible_version_fails_before_worker_resolution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, _home = isolated_manager(tmp_path, monkeypatch, enabled=True)
    manager.discover_and_load()
    bridge = manager._plugins["cmai-hermes"].module.bridge
    assert bridge.is_supported_hermes("0.19.0") is True
    monkeypatch.setattr(bridge, "_resolve_worker", lambda *args, **kwargs: pytest.fail("worker must not resolve"))

    result = bridge.run_cmai_command("feed", hermes_version="0.20.0")

    assert "outside >=0.18.2 <0.20.0" in result
    assert "No worker, network request, or model call" in result


def test_worker_resolution_ignores_overrides_and_requires_manifest_integrity(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, _home = isolated_manager(tmp_path, monkeypatch, enabled=True)
    manager.discover_and_load()
    loaded = manager._plugins["cmai-hermes"]
    bridge = loaded.module.bridge
    plugin_root = Path(bridge.__file__).resolve().parent
    worker = plugin_root / "runtime" / "worker.js"
    worker.parent.mkdir()
    worker.write_bytes(b"reviewed-worker")
    digest = hashlib.sha256(worker.read_bytes()).hexdigest()
    (plugin_root / "artifact-manifest.json").write_text(json.dumps({
        "schema_version": 1,
        "package": "@challenge-my-ai/hermes-adapter",
        "files": [{"path": "runtime/worker.js", "sha256": digest}],
    }), encoding="utf-8")
    override = tmp_path / "untrusted-worker.js"
    override.write_text("untrusted", encoding="utf-8")
    monkeypatch.setenv("CMAI_HERMES_ADAPTER_WORKER", str(override))

    assert bridge._resolve_worker() == worker
    worker.write_bytes(b"tampered-worker")
    assert bridge._resolve_worker() is None


def test_worker_environment_is_an_allowlist_without_provider_credentials(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, home = isolated_manager(tmp_path, monkeypatch, enabled=True)
    manager.discover_and_load()
    bridge = manager._plugins["cmai-hermes"].module.bridge
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-pass")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-pass")
    monkeypatch.setenv("DATABASE_URL", "must-not-pass")
    monkeypatch.setenv("CMAI_AGENT_BASE_URL", "https://challenge-my-ai.example")

    environment = bridge._worker_environment("0.18.2", "test-profile")

    assert environment["CMAI_HERMES_STATE_DIR"] == str(home / "state" / "cmai-hermes")
    assert environment["CMAI_HERMES_PROFILE_NAME"] == "test-profile"
    assert environment["CMAI_AGENT_BASE_URL"] == "https://challenge-my-ai.example"
    assert "OPENAI_API_KEY" not in environment
    assert "ANTHROPIC_API_KEY" not in environment
    assert "DATABASE_URL" not in environment
    assert "HERMES_HOME" not in environment
    assert set(environment) <= {
        "PATH", "CMAI_HERMES_HOST_VERSION", "CMAI_HERMES_PROFILE_NAME", "CMAI_HERMES_STATE_DIR",
        "CMAI_AGENT_BASE_URL", "LANG", "LC_ALL", "TMPDIR",
    }


def test_confirmed_worker_deadline_exceeds_network_plus_full_host_inference_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _home = isolated_manager(tmp_path, monkeypatch, enabled=True)
    manager.discover_and_load()
    bridge = manager._plugins["cmai-hermes"].module.bridge

    assert bridge.DEFAULT_WORKER_TIMEOUT_SECONDS == 75
    assert bridge.DEFAULT_WORKER_TIMEOUT_SECONDS > (
        bridge.CLIENT_NETWORK_TIMEOUT_SECONDS + bridge.HOST_INFERENCE_TIMEOUT_SECONDS
    )
    assert bridge.BRIDGE_PROCESSING_HEADROOM_SECONDS >= 15


def test_host_llm_bridge_makes_exactly_one_fixed_structured_call_without_route_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _home = isolated_manager(tmp_path, monkeypatch, enabled=True)
    manager.discover_and_load()
    bridge = manager._plugins["cmai-hermes"].module.bridge
    inference = bridge.complete_structured_once
    calls: list[dict[str, object]] = []

    class Result:
        parsed = {"schema_version": "1.0", "challenge_id": "challenge_1"}
        provider = "  host\nprovider  "
        model = "host/model"

    class FakeLlm:
        def complete_structured(self, **kwargs):
            calls.append(kwargs)
            return Result()

    request = valid_inference_request(bridge)
    response = inference(FakeLlm(), request)

    assert len(calls) == 1
    assert set(calls[0]) == {
        "instructions", "input", "json_schema", "purpose", "max_tokens", "temperature", "timeout"
    }
    assert not {"provider", "model", "profile", "agent_id"}.intersection(calls[0])
    assert calls[0]["max_tokens"] == 4096
    assert calls[0]["timeout"] == 45
    assert response == {
        "parsed": Result.parsed,
        "provider": "host provider",
        "model": "host/model",
    }


def test_host_llm_bridge_rejects_budget_drift_and_redacts_provider_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _home = isolated_manager(tmp_path, monkeypatch, enabled=True)
    manager.discover_and_load()
    bridge = manager._plugins["cmai-hermes"].module.bridge
    request = valid_inference_request(bridge)

    class FailingLlm:
        def __init__(self) -> None:
            self.calls = 0

        def complete_structured(self, **_kwargs):
            self.calls += 1
            raise RuntimeError("provider secret detail")

    llm = FailingLlm()
    with pytest.raises(bridge.HostInferenceFailure, match="fixed inference budget"):
        bridge.complete_structured_once(llm, {**request, "maxTokens": 4097})
    with pytest.raises(bridge.HostInferenceFailure, match="fixed inference instructions"):
        bridge.complete_structured_once(llm, {**request, "instructions": "arbitrary"})
    with pytest.raises(bridge.HostInferenceFailure, match="fixed contribution schema"):
        bridge.complete_structured_once(llm, {**request, "jsonSchema": {"type": "object"}})
    expired_payload = json.loads(str(request["inputText"]))
    expired_payload["challenge"]["run_grant"]["expires_at"] = "2000-01-01T00:00:00.000Z"
    with pytest.raises(bridge.HostInferenceFailure, match="invalid or expired challenge grant"):
        bridge.complete_structured_once(llm, {**request, "inputText": json.dumps(expired_payload)})
    assert llm.calls == 0
    with pytest.raises(bridge.HostInferenceFailure) as caught:
        bridge.complete_structured_once(llm, request)
    assert llm.calls == 1
    assert caught.value.code == "inference_failed"
    assert "provider secret detail" not in str(caught.value)
