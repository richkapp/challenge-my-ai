"""Bounded subprocess bridge from Hermes' Python plugin API to the TS client adapter."""

from __future__ import annotations

import hashlib
import json
import os
import select
import shutil
import subprocess
import time
import uuid
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Optional, TextIO

from .inference import HostInferenceFailure, INSTRUCTIONS, complete_structured_once, load_fixed_schema


SUPPORTED_RANGE = ">=0.18.2 <0.20.0"
MAX_OUTPUT_BYTES = 512 * 1024
CLIENT_NETWORK_TIMEOUT_SECONDS = 15
HOST_INFERENCE_TIMEOUT_SECONDS = 45
BRIDGE_PROCESSING_HEADROOM_SECONDS = 15
DEFAULT_WORKER_TIMEOUT_SECONDS = (
    CLIENT_NETWORK_TIMEOUT_SECONDS
    + HOST_INFERENCE_TIMEOUT_SECONDS
    + BRIDGE_PROCESSING_HEADROOM_SECONDS
)


def current_hermes_version() -> str:
    try:
        return version("hermes-agent")
    except PackageNotFoundError:
        return "unknown"


def _version_tuple(raw: str) -> Optional[tuple[int, int, int]]:
    pieces = raw.strip().split(".")
    if len(pieces) < 3:
        return None
    try:
        return (
            int(pieces[0].split("-", 1)[0].split("+", 1)[0]),
            int(pieces[1].split("-", 1)[0].split("+", 1)[0]),
            int(pieces[2].split("-", 1)[0].split("+", 1)[0]),
        )
    except ValueError:
        return None


def is_supported_hermes(raw: str) -> bool:
    parsed = _version_tuple(raw)
    return parsed is not None and (0, 18, 2) <= parsed < (0, 20, 0)


def _resolve_worker() -> Optional[Path]:
    """Return only the staged worker whose bytes match the private artifact manifest."""

    plugin_directory = Path(__file__).resolve().parent
    worker = plugin_directory / "runtime" / "worker.js"
    manifest_path = plugin_directory / "artifact-manifest.json"
    if worker.is_symlink() or manifest_path.is_symlink() or not worker.is_file() or not manifest_path.is_file():
        return None
    try:
        manifest_bytes = manifest_path.read_bytes()
        if len(manifest_bytes) > 256 * 1024:
            return None
        manifest = json.loads(manifest_bytes)
        if (
            not isinstance(manifest, dict)
            or manifest.get("schema_version") != 1
            or manifest.get("package") != "@challenge-my-ai/hermes-adapter"
            or not isinstance(manifest.get("files"), list)
        ):
            return None
        matches = [
            entry for entry in manifest["files"]
            if isinstance(entry, dict)
            and set(entry) == {"path", "sha256"}
            and entry.get("path") == "runtime/worker.js"
            and isinstance(entry.get("sha256"), str)
        ]
        if len(matches) != 1:
            return None
        expected = matches[0]["sha256"]
        if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
            return None
        actual = hashlib.sha256(worker.read_bytes()).hexdigest()
        return worker.resolve() if actual == expected else None
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None


def _worker_environment(hermes_version: str, profile_name: str) -> dict[str, str]:
    if not profile_name or len(profile_name) > 128 or any(
        character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"
        for character in profile_name
    ):
        raise ValueError("invalid Hermes profile name")
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).resolve()
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "CMAI_HERMES_HOST_VERSION": hermes_version,
        "CMAI_HERMES_PROFILE_NAME": profile_name,
        "CMAI_HERMES_STATE_DIR": str(hermes_home / "state" / "cmai-hermes"),
    }
    for key in ("LANG", "LC_ALL", "TMPDIR"):
        if os.environ.get(key):
            environment[key] = os.environ[key]
    if os.environ.get("CMAI_AGENT_BASE_URL"):
        environment["CMAI_AGENT_BASE_URL"] = os.environ["CMAI_AGENT_BASE_URL"]
    return environment


def _worker_request(request_id: str, raw_args: str) -> str:
    return json.dumps({"id": request_id, "command": raw_args}, separators=(",", ":"))


def _parse_final_response(raw: str, request_id: str) -> str:
    encoded = raw.encode("utf-8", errors="replace")
    if not encoded or len(encoded) > MAX_OUTPUT_BYTES:
        raise ValueError("unbounded result")
    response = json.loads(raw)
    if (
        not isinstance(response, dict)
        or response.get("id") != request_id
        or set(response) != {"id", "result"}
        or not isinstance(response.get("result"), dict)
        or set(response["result"]) != {"ok", "code", "text"}
        or not isinstance(response["result"].get("ok"), bool)
        or not isinstance(response["result"].get("code"), str)
        or not isinstance(response["result"].get("text"), str)
    ):
        raise ValueError("invalid response shape")
    return response["result"]["text"]


def is_confirmed_run(raw_args: str) -> bool:
    pieces = raw_args.strip().split()
    return len(pieces) == 4 and pieces[0].lower() == "run" and pieces[2].lower() == "confirm"


def _readline_bounded(stream: TextIO, deadline: float) -> str:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("worker deadline exceeded")
    ready, _, _ = select.select([stream], [], [], remaining)
    if not ready:
        raise TimeoutError("worker deadline exceeded")
    line = stream.readline(MAX_OUTPUT_BYTES + 1)
    if not line or len(line.encode("utf-8", errors="replace")) > MAX_OUTPUT_BYTES:
        raise ValueError("worker frame missing or oversized")
    return line.rstrip("\r\n")


def _interactive_inference_command(
    *,
    bun: str,
    worker: Path,
    request_id: str,
    raw_args: str,
    installed: str,
    profile_name: str,
    llm: Any,
    timeout_seconds: int,
) -> str:
    process: subprocess.Popen[str] | None = None
    deadline = time.monotonic() + timeout_seconds
    try:
        process = subprocess.Popen(
            [bun, str(worker)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=_worker_environment(installed, profile_name),
        )
        if process.stdin is None or process.stdout is None:
            raise OSError("worker pipes unavailable")
        process.stdin.write(_worker_request(request_id, raw_args) + "\n")
        process.stdin.flush()
        first_raw = _readline_bounded(process.stdout, deadline)
        first = json.loads(first_raw)
        if isinstance(first, dict) and set(first) == {"id", "result"}:
            process.stdin.close()
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
            return _parse_final_response(first_raw, request_id)
        if (
            not isinstance(first, dict)
            or first.get("id") != request_id
            or first.get("event") != "inference_request"
            or set(first) != {"id", "event", "request"}
        ):
            raise ValueError("invalid inference request frame")
        result = complete_structured_once(llm, first["request"])
        process.stdin.write(json.dumps({"id": request_id, "event": "inference_result", "result": result}, separators=(",", ":")) + "\n")
        process.stdin.flush()
        process.stdin.close()
        final_raw = _readline_bounded(process.stdout, deadline)
        process.wait(timeout=max(0.1, deadline - time.monotonic()))
        return _parse_final_response(final_raw, request_id)
    except HostInferenceFailure as exc:
        return f"{exc.safe_message} Nothing was submitted."
    except (OSError, TimeoutError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError, TypeError):
        return "The CMAI adapter worker or bounded Hermes inference failed safely. No raw error, response content, or credential material was exposed."
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass


def run_cmai_command(
    raw_args: str,
    *,
    llm: Any = None,
    hermes_version: Optional[str] = None,
    profile_name: str = "default",
    timeout_seconds: int = DEFAULT_WORKER_TIMEOUT_SECONDS,
) -> str:
    """Run exactly one explicit CMAI command; confirmed runs may make one host-owned LLM call."""
    installed = hermes_version or current_hermes_version()
    if not is_supported_hermes(installed):
        return (
            f"CMAI Hermes adapter disabled: Hermes {installed} is outside {SUPPORTED_RANGE}. "
            "No worker, network request, or model call was started."
        )

    worker = _resolve_worker()
    bun = shutil.which("bun")
    if worker is None or bun is None:
        return (
            "CMAI Hermes adapter is installed but its reviewed local worker or Bun runtime is unavailable. "
            "No network request or model call was started. Rebuild and reinstall the local artifact."
        )
    if is_confirmed_run(raw_args) and llm is None:
        return "The CMAI Hermes structured-inference host is unavailable. No model call or submission occurred."

    request_id = f"cmd_{uuid.uuid4().hex}"
    if is_confirmed_run(raw_args):
        return _interactive_inference_command(
            bun=bun,
            worker=worker,
            request_id=request_id,
            raw_args=raw_args,
            installed=installed,
            profile_name=profile_name,
            llm=llm,
            timeout_seconds=timeout_seconds,
        )

    try:
        completed = subprocess.run(
            [bun, str(worker)],
            input=_worker_request(request_id, raw_args),
            text=True,
            capture_output=True,
            timeout=min(timeout_seconds, 25),
            check=False,
            env=_worker_environment(installed, profile_name),
        )
        return _parse_final_response(completed.stdout, request_id)
    except (OSError, subprocess.TimeoutExpired):
        return "The CMAI adapter worker was unavailable or timed out. No raw error, response content, or credential material was exposed."
    except (json.JSONDecodeError, ValueError, TypeError):
        return "The CMAI adapter worker returned an invalid result, which was discarded."
