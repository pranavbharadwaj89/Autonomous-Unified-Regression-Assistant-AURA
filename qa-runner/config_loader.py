"""
Central config loader — enforces LLM role isolation.

  • Executor (LLM 1): .env.executor  → GPT-5.4 Nano — regression / CARA agent only
  • Judge    (LLM 2): .env.judge     → GPT-5.4 Mini — judge prompts only
  • PRISM models:     .env.model*    → via prism_runner.discover_model_configs() only

Never load executor keys into judge code paths or vice versa.
PRISM must NOT read .env.executor or .env.judge.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from dotenv import dotenv_values
except ImportError:
    def dotenv_values(path: str) -> dict:  # type: ignore
        out: dict[str, str] = {}
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip()
        return out


_QA_ROOT = Path(__file__).resolve().parent
_JUDGE_SETTINGS_PATH = _QA_ROOT / "judge_config.json"


def _load_dotenv(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise FileNotFoundError(f"Config file not found: {path}")
    raw = dotenv_values(str(path))
    return {k: v for k, v in raw.items() if v is not None}


def load_judge_settings() -> dict[str, Any]:
    if not _JUDGE_SETTINGS_PATH.is_file():
        return {
            "pass_threshold": 80,
            "partial_threshold": 50,
            "report_format": "html",
            "llm_timeout_seconds": 90,
        }
    with open(_JUDGE_SETTINGS_PATH, encoding="utf-8") as f:
        return json.load(f)


def get_executor_config() -> dict[str, str]:
    """LLM 1 — 5.4 Nano for regression executor (not PRISM)."""
    settings = load_judge_settings()
    env_file = settings.get("executor_env_file", ".env.executor")
    cfg = _load_dotenv(_QA_ROOT / env_file)
    if cfg.get("ROLE") != "executor":
        raise ValueError(f"{env_file} must have ROLE=executor")
    return cfg


def get_judge_config() -> dict[str, str]:
    """LLM 2 — dedicated judge model; isolated from executor."""
    settings = load_judge_settings()
    env_file = settings.get("judge_env_file", ".env.judge")
    cfg = _load_dotenv(_QA_ROOT / env_file)
    if cfg.get("ROLE") != "judge":
        raise ValueError(f"{env_file} must have ROLE=judge")
    return cfg


def get_config_summary() -> dict[str, Any]:
    """Public metadata for UI (no API keys)."""
    try:
        ex = get_executor_config()
    except Exception as e:
        ex = {"error": str(e)}
    try:
        jd = get_judge_config()
    except Exception as e:
        jd = {"error": str(e)}
    settings = load_judge_settings()
    return {
        "executor": {
            "display_name": ex.get("MODEL_DISPLAY_NAME"),
            "model": ex.get("LLM_MODEL_NAME") or ex.get("CARA_MODEL_NAME"),
            "cara_model": ex.get("CARA_MODEL_NAME"),
            "error": ex.get("error"),
        },
        "judge": {
            "display_name": jd.get("MODEL_DISPLAY_NAME"),
            "model": jd.get("LLM_MODEL_NAME"),
            "error": jd.get("error"),
        },
        "thresholds": {
            "pass": settings.get("pass_threshold", 80),
            "partial": settings.get("partial_threshold", 50),
        },
        "report_format": settings.get("report_format", "html"),
        "note": "PRISM uses .env.model* only; executor/judge configs are not shared with PRISM.",
    }
