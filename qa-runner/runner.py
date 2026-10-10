"""Execute CARA voice E2E suites via run_e2e_with_standard_report.py.

Improvements over v1:
  - Per-suite subprocess retry (CARA_SUITE_RETRIES, default 2)
  - Structured error dict with stdout/stderr fields for dashboard surfacing
  - CARA_BACKEND_PATH env var honoured first; cleaner candidate list
  - _resolve_python_command also checks .venv / venv (not only .venv312)
  - runs_dir() respects CARA_RUNS_DIR env override
  - discover_suites() gracefully handles a missing scripts dir
  - Forwards E2E_RETRY_DELAY_S and E2E_COLLECT_SECONDS to the report script
  - Per-suite timeout via CARA_SUITE_TIMEOUT_<SUITE_ID> (falls back to QA_RUN_TIMEOUT_SEC)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

DEFAULT_SMOKE_SUITES = [
    "handle_session",
    "handle_weather",
    "handle_assistant_info",
]

SUITE_DISPLAY_NAMES: dict[str, str] = {
    "handle_session": "Session",
    "handle_weather": "Weather",
    "handle_assistant_info": "Assistant Info",
    "handle_entertainment": "Entertainment",
    "handle_navigation": "Navigation",
    "handle_transport": "Transport",
    "handle_places_search": "Places Search",
    "handle_user_profile": "User Profile",
    "reminders": "Reminders",
    "guardrails_policy": "Guardrails Policy",
}


# ── Path helpers ─────────────────────────────────────────────────────────────

def _qa_runner_root() -> Path:
    return Path(__file__).resolve().parent


def _suite_root() -> Path:
    return _qa_runner_root().parent


def _load_dotenv_file(path: Path) -> None:
    """Load a single .env file into os.environ using setdefault (no OS-env override)."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def load_suite_env() -> None:
    """Load .env files into os.environ without overriding values already set.

    Search order (highest priority first — first file to set a key wins):
      1. qa-runner/.env        — QA runner–specific config, OPENAI_API_KEY, DB vars, etc.
      2. <suite-root>/.env     — top-level project .env (legacy / shared keys)

    Real OS environment variables always take precedence over any .env file.
    """
    # 1. Load the qa-runner's own .env first — most specific, highest priority
    _load_dotenv_file(_qa_runner_root() / ".env")
    # 2. Fall back to the suite-root .env for anything not yet set
    _load_dotenv_file(_suite_root() / ".env")


def runs_dir() -> Path:
    """Return (and create) the runs output directory.

    Respects CARA_RUNS_DIR env var so CI can redirect output easily.
    """
    override = os.environ.get("CARA_RUNS_DIR", "").strip()
    path = Path(override).resolve() if override else _qa_runner_root() / "runs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _backend_path_candidates() -> list[Path]:
    env = os.environ.get("CARA_BACKEND_PATH", "").strip()
    if env:
        return [Path(env).resolve()]

    suite_root = _suite_root()
    return [
        # Most likely location when the full repo is checked out
        suite_root / "backend-feature-demo-develop" / "cara_backend",
        # Legacy nested path
        suite_root
        / "src"
        / "CARA_Automation"
        / "BE Code Unziped"
        / "backend-feature-demo-develop"
        / "cara_backend",
        # Home-dir fallback
        Path.home()
        / "frontend"
        / "qa-tool"
        / "src"
        / "CARA_Automation"
        / "BE Code Unziped"
        / "backend-feature-demo-develop"
        / "cara_backend",
    ]


def get_cara_backend_path() -> Path:
    for candidate in _backend_path_candidates():
        if candidate.is_dir():
            return candidate.resolve()
    return _backend_path_candidates()[0].resolve()


def _scripts_dir() -> Path:
    return get_cara_backend_path() / "tests" / "e2e_voice" / "scripts"


# ── Suite discovery ──────────────────────────────────────────────────────────

def _count_cases(yaml_path: Path) -> int:
    try:
        data = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
        return len(data.get("cases", [])) if isinstance(data, dict) else 0
    except Exception:
        return 0


def discover_suites() -> list[dict]:
    scripts = _scripts_dir()
    suites: list[dict] = []
    if not scripts.is_dir():
        return suites

    for path in sorted(scripts.glob("tool_*.yaml")):
        suite_id = path.stem[len("tool_"):]
        suites.append(
            {
                "id": suite_id,
                "name": SUITE_DISPLAY_NAMES.get(
                    suite_id,
                    suite_id.replace("handle_", "").replace("_", " ").title(),
                ),
                "caseCount": _count_cases(path),
                "isSmoke": suite_id in DEFAULT_SMOKE_SUITES,
            }
        )
    return suites


# ── Python command resolution ────────────────────────────────────────────────

def _resolve_python_command(backend: Path) -> list[str]:
    poetry = shutil.which("poetry")
    if poetry:
        return [poetry, "run", "python"]

    # Check several common venv names
    for venv_name in (".venv312", ".venv", "venv"):
        for sub in (("Scripts", "python.exe"), ("bin", "python")):
            candidate = backend / venv_name / Path(*sub)
            if candidate.is_file():
                return [str(candidate)]

    return [sys.executable]


# ── Suite execution ──────────────────────────────────────────────────────────

def execute_run(suite_id: str, base_url: str, output_dir: Path) -> dict:
    """Run a single suite and return a result dict.

    Retries up to CARA_SUITE_RETRIES times (default 2) on non-zero exit.
    Returns a dict with keys: suite, error, returncode, stdout, stderr.
    """
    backend = get_cara_backend_path()
    tool_yaml = backend / "tests" / "e2e_voice" / "scripts" / f"tool_{suite_id}.yaml"
    report_script = backend / "reports" / "run_e2e_with_standard_report.py"

    if not tool_yaml.is_file():
        return {
            "suite": suite_id,
            "error": f"Suite YAML not found: {tool_yaml}",
            "returncode": -1,
            "stdout": "",
            "stderr": "",
        }
    if not report_script.is_file():
        return {
            "suite": suite_id,
            "error": f"Report script not found: {report_script}",
            "returncode": -1,
            "stdout": "",
            "stderr": "",
        }

    output_dir.mkdir(parents=True, exist_ok=True)
    python_cmd = _resolve_python_command(backend)
    cmd = [
        *python_cmd,
        "-m",
        "reports.run_e2e_with_standard_report",
        "--tool-yaml",
        str(tool_yaml),
        "--output-dir",
        str(output_dir),
        "--base-url",
        base_url,
    ]

    retry_delay_s = os.environ.get("E2E_RETRY_DELAY_S", "5").strip()
    if retry_delay_s:
        cmd.extend(["--retry-delay-s", retry_delay_s])

    collect_seconds = os.environ.get("E2E_COLLECT_SECONDS", "").strip()
    if collect_seconds:
        cmd.extend(["--collect-seconds", collect_seconds])

    env = os.environ.copy()
    env["BASE_URL"] = base_url
    env["RUN_E2E_VOICE_LIVE"] = "1"
    env["PYTHONPATH"] = str(backend)

    # Load cara_backend .env without overriding process env
    dotenv = backend / ".env"
    if dotenv.is_file():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env.setdefault(key.strip(), value.strip())

    # Per-suite timeout: CARA_SUITE_TIMEOUT_<SUITE_ID> (e.g. CARA_SUITE_TIMEOUT_HANDLE_WEATHER)
    suite_timeout_key = f"CARA_SUITE_TIMEOUT_{suite_id.upper()}"
    timeout_sec = int(
        os.environ.get(suite_timeout_key, os.environ.get("QA_RUN_TIMEOUT_SEC", "3600"))
    )
    max_retries = int(os.environ.get("CARA_SUITE_RETRIES", "2"))

    last_result: dict = {}
    for attempt in range(1, max_retries + 1):
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(backend),
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout_sec,
            )
            stdout = (proc.stdout or "").strip()
            stderr = (proc.stderr or "").strip()

            if proc.returncode == 0:
                return {
                    "suite": suite_id,
                    "error": None,
                    "returncode": 0,
                    "stdout": stdout[-3000:],
                    "stderr": stderr[-1000:],
                }

            # Non-zero exit — capture and maybe retry
            last_result = {
                "suite": suite_id,
                "error": (
                    f"Exit code {proc.returncode} on attempt {attempt}/{max_retries}: "
                    + (stderr or stdout)[-2000:]
                ),
                "returncode": proc.returncode,
                "stdout": stdout[-3000:],
                "stderr": stderr[-2000:],
            }

        except subprocess.TimeoutExpired:
            last_result = {
                "suite": suite_id,
                "error": f"Run timed out after {timeout_sec}s (attempt {attempt}/{max_retries})",
                "returncode": -1,
                "stdout": "",
                "stderr": "",
            }
        except Exception as exc:
            last_result = {
                "suite": suite_id,
                "error": f"Unexpected error on attempt {attempt}/{max_retries}: {exc}",
                "returncode": -1,
                "stdout": "",
                "stderr": "",
            }

    return last_result
