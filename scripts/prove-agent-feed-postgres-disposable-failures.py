#!/usr/bin/env python3
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / "scripts/prove-agent-feed-postgres-disposable.sh"
CLEANUP_MARKER = "cleanup verified: database=0 role=0"


def run_case(env_overrides: dict[str, str], expected_status: int, label: str, *, failure_mode: bool = True) -> None:
    env = os.environ.copy()
    env.update(env_overrides)
    if failure_mode:
        env["CMAI_AGENT_FEED_PROOF_FAILURE_TEST_MODE"] = "1"
    result = subprocess.run(["bash", str(HARNESS)], cwd=ROOT, env=env, text=True, capture_output=True)
    if result.returncode != expected_status or CLEANUP_MARKER not in result.stdout:
        raise RuntimeError(
            f"{label} failed: status={result.returncode}, expected={expected_status}\n{result.stdout}\n{result.stderr}",
        )
    print(f"{label}=passed")


def main() -> None:
    expected = {"HUP": 129, "INT": 130, "TERM": 143}
    for signal, status in expected.items():
        for point in ("before-role", "after-role-create", "after-database-create", "after-boundary"):
            run_case(
                {
                    "CMAI_AGENT_FEED_PROOF_TEST_SIGNAL": signal,
                    "CMAI_AGENT_FEED_PROOF_TEST_SIGNAL_POINT": point,
                },
                status,
                f"signal-{signal.lower()}-{point}",
            )
    for resource in ("role", "database"):
        run_case(
            {"CMAI_AGENT_FEED_PROOF_TEST_CLIENT_ERROR_AFTER_CREATE": resource},
            1,
            f"ambiguous-client-error-after-{resource}",
        )
    run_case(
        {
            "CMAI_AGENT_FEED_PROOF_TEST_SIGNAL": "TERM",
            "CMAI_AGENT_FEED_PROOF_TEST_SIGNAL_POINT": "cleanup",
            "CMAI_AGENT_FEED_PROOF_TEST_EXIT_AFTER_BOUNDARY": "1",
        },
        42,
        "signal-during-cleanup-ignored",
    )
    run_case(
        {
            "CMAI_AGENT_FEED_PROOF_TEST_SIGNAL": "KILL",
            "CMAI_AGENT_FEED_PROOF_TEST_SIGNAL_POINT": "after-role-create",
        },
        2,
        "unsupported-postcreate-signal-refused-before-create",
    )
    run_case(
        {
            "CMAI_AGENT_FEED_PROOF_TEST_SIGNAL": "KILL",
            "CMAI_AGENT_FEED_PROOF_TEST_SIGNAL_POINT": "cleanup",
            "CMAI_AGENT_FEED_PROOF_TEST_EXIT_AFTER_BOUNDARY": "1",
        },
        2,
        "unsupported-cleanup-signal-refused-before-create",
    )
    run_case(
        {
            "CMAI_AGENT_FEED_PROOF_TEST_SIGNAL": "KILL",
            "CMAI_AGENT_FEED_PROOF_TEST_SIGNAL_POINT": "after-role-create",
            "CMAI_AGENT_FEED_PROOF_TEST_CLIENT_ERROR_AFTER_CREATE": "role",
            "CMAI_AGENT_FEED_PROOF_TEST_EXIT_AFTER_BOUNDARY": "1",
        },
        0,
        "ambient-failure-hooks-ignored-without-master-gate",
        failure_mode=False,
    )

    residue = subprocess.run(
        [
            "sudo", "-n", "-u", "postgres", "psql", "-Atqc",
            "SELECT count(*) FROM pg_database WHERE datname LIKE 'cmai_agent_feed_proof_%'; "
            "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'cmai_proof_%';",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.splitlines()
    if residue != ["0", "0"]:
        raise RuntimeError(f"Disposable PostgreSQL failure matrix left residue: {residue}")
    print("disposable-failure-matrix-cleanup=passed")


if __name__ == "__main__":
    main()
