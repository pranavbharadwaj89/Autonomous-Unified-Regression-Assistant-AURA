"""
prism_runner.py
─────────────────────────────────────────────────────────────────────────────
Parallel multi-model benchmark runner for PRISM.

Design principles (following user spec):
  • Uses dotenv_values() — NOT load_dotenv() — so no os.environ mutation.
  • Each model gets its own isolated config dict parsed from .env.modelN files.
  • Model-calling code receives config explicitly as a parameter.
  • True parallelism via concurrent.futures.ThreadPoolExecutor —
    all (query × model) combinations run concurrently in one pass.

Config file discovery:
  Looks for  qa-runner/.env.model1, .env.model2, .env.model3 … in order.
  Each file must define at minimum: LLM_PROVIDER, LLM_API_KEY, LLM_MODEL_NAME.
  Optional keys: LLM_BASE_URL, MODEL_DISPLAY_NAME, INPUT_COST_PER_1K,
                 OUTPUT_COST_PER_1K, MODEL_COLOR.

Supported providers:
  openai     — POST {LLM_BASE_URL}/chat/completions   (OpenAI-compatible)
  gemini     — POST {LLM_BASE_URL}/models/{model}:generateContent?key=...

Adding a new provider:
  Add a branch in _call_model_sync() below.
"""

from __future__ import annotations

import concurrent.futures
import json
import re
import time
from pathlib import Path
from typing import Any

import httpx

# ── python-dotenv: dotenv_values gives an isolated dict without mutating os.environ ──
try:
    from dotenv import dotenv_values
    _DOTENV_AVAILABLE = True
except ImportError:
    _DOTENV_AVAILABLE = False
    def dotenv_values(path):          # minimal fallback parser
        result = {}
        try:
            for line in Path(path).read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                result[k.strip()] = v.strip()
        except FileNotFoundError:
            pass
        return result


# ── Config discovery ──────────────────────────────────────────────────────────

def _runner_dir() -> Path:
    return Path(__file__).resolve().parent


def discover_model_configs() -> list[dict]:
    """
    Read every .env.model* file in the qa-runner directory into an isolated dict.
    Returns a list of config dicts, one per file, sorted by filename.
    No values are written to os.environ.
    """
    files = sorted(_runner_dir().glob(".env.model*"))
    configs = []
    for f in files:
        cfg = dict(dotenv_values(str(f)))
        if not cfg.get("LLM_MODEL_NAME"):
            continue                          # skip incomplete files
        cfg["_env_file"]   = f.name
        cfg["_env_path"]   = str(f)
        cfg.setdefault("MODEL_DISPLAY_NAME", cfg["LLM_MODEL_NAME"])
        cfg.setdefault("LLM_PROVIDER",       "openai")
        cfg.setdefault("LLM_BASE_URL",       "https://api.openai.com/v1")
        cfg.setdefault("INPUT_COST_PER_1K",  "0.001")
        cfg.setdefault("OUTPUT_COST_PER_1K", "0.003")
        cfg.setdefault("MODEL_COLOR",        "#94a3b8")
        configs.append(cfg)
    return configs


def get_available_models() -> list[dict]:
    """Return JSON-serialisable model metadata list for the frontend."""
    return [
        {
            "id":            cfg["LLM_MODEL_NAME"],
            "name":          cfg["MODEL_DISPLAY_NAME"],
            "provider":      cfg["LLM_PROVIDER"].title(),
            "inputPer1k":    float(cfg["INPUT_COST_PER_1K"]),
            "outputPer1k":   float(cfg["OUTPUT_COST_PER_1K"]),
            "color":         cfg["MODEL_COLOR"],
            "envFile":       cfg["_env_file"],
        }
        for cfg in discover_model_configs()
    ]


# ── Model calling — config is passed explicitly, never read from os.environ ───

def _call_model_sync_timed(config: dict, prompt: str, system_prompt: str = "") -> dict:
    """Wrapper that adds wall-clock started_at / completed_at timestamps."""
    started_at = time.time()
    result = _call_model_sync(config, prompt, system_prompt)
    result["started_at"]    = started_at
    result["completed_at"]  = time.time()
    return result


def _call_model_sync(config: dict, prompt: str, system_prompt: str = "") -> dict:
    """
    Synchronously call one model using credentials from config dict.
    config must contain: LLM_PROVIDER, LLM_API_KEY, LLM_MODEL_NAME
    Optional: LLM_BASE_URL

    Returns:
        { content, model, provider, prompt_tokens, completion_tokens,
          total_tokens, latency_ms, error }
    """
    provider   = config.get("LLM_PROVIDER", "openai").lower().strip()
    api_key    = config.get("LLM_API_KEY", "")
    model_name = config.get("LLM_MODEL_NAME", "")

    if not api_key:
        return _error_result(model_name, provider, "LLM_API_KEY not set in config file")
    if not model_name:
        return _error_result("unknown", provider, "LLM_MODEL_NAME not set in config file")

    t0 = time.perf_counter()

    try:
        if provider in ("openai", "openai_proxy"):
            result = _call_openai(config, prompt, system_prompt, api_key, model_name)
        elif provider == "gemini":
            result = _call_gemini(config, prompt, system_prompt, api_key, model_name)
        else:
            return _error_result(model_name, provider, f"Unsupported provider: {provider!r}")
    except httpx.HTTPStatusError as e:
        return _error_result(model_name, provider, f"HTTP {e.response.status_code}: {e.response.text[:200]}")
    except Exception as e:
        return _error_result(model_name, provider, str(e))

    result["latency_ms"] = round((time.perf_counter() - t0) * 1000)
    return result


def _call_openai(config: dict, prompt: str, system_prompt: str, api_key: str, model_name: str) -> dict:
    base = config.get("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    with httpx.Client(timeout=90) as client:
        resp = client.post(
            f"{base}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type":  "application/json",
            },
            json={
                "model":       model_name,
                "messages":    messages,
                "temperature": 0.3,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    choice  = data["choices"][0]["message"]["content"]
    usage   = data.get("usage", {})
    return {
        "content":            choice,
        "model":              model_name,
        "provider":           "openai",
        "prompt_tokens":      usage.get("prompt_tokens", 0),
        "completion_tokens":  usage.get("completion_tokens", 0),
        "total_tokens":       usage.get("total_tokens", 0),
        "latency_ms":         0,   # filled by caller
        "error":              None,
    }


def _call_gemini(config: dict, prompt: str, system_prompt: str, api_key: str, model_name: str) -> dict:
    base = config.get("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
    url  = f"{base}/models/{model_name}:generateContent?key={api_key}"

    text = f"{system_prompt}\n\n{prompt}".strip() if system_prompt else prompt
    with httpx.Client(timeout=90) as client:
        resp = client.post(
            url,
            json={"contents": [{"parts": [{"text": text}]}]},
            headers={"Content-Type": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()

    content = data["candidates"][0]["content"]["parts"][0]["text"]
    meta    = data.get("usageMetadata", {})
    p_tok   = meta.get("promptTokenCount", 0)
    c_tok   = meta.get("candidatesTokenCount", 0)
    return {
        "content":            content,
        "model":              model_name,
        "provider":           "gemini",
        "prompt_tokens":      p_tok,
        "completion_tokens":  c_tok,
        "total_tokens":       p_tok + c_tok,
        "latency_ms":         0,
        "error":              None,
    }


def _error_result(model: str, provider: str, msg: str) -> dict:
    return {
        "content":           "",
        "model":             model,
        "provider":          provider,
        "prompt_tokens":     0,
        "completion_tokens": 0,
        "total_tokens":      0,
        "latency_ms":        0,
        "error":             msg,
    }


# ── Cost estimator ────────────────────────────────────────────────────────────

def _estimate_cost(config: dict, prompt_tokens: int, completion_tokens: int) -> float:
    inp_rate = float(config.get("INPUT_COST_PER_1K",  "0.001"))
    out_rate = float(config.get("OUTPUT_COST_PER_1K", "0.003"))
    return round(
        (prompt_tokens / 1000) * inp_rate + (completion_tokens / 1000) * out_rate,
        8,
    )


# ── Parallel benchmark runner ─────────────────────────────────────────────────

def run_prism_benchmark(
    queries: list[dict],
    env_files: list[str] | None = None,
    system_prompt: str = "",
) -> dict:
    """
    Run every query against every model in parallel and return raw results.

    Parameters
    ----------
    queries : list of { id, text, language, expectedIntent, expectedResponse }
    env_files : optional list of .env file basenames (e.g. [".env.model1"])
                 — defaults to ALL .env.model* files found
    system_prompt : optional system prompt prepended to every query

    Returns
    -------
    {
        "models":  [ { id, name, provider, ... } ],
        "results": {
            "<model_id>": {
                "<query_id>": {
                    content, latency_ms, prompt_tokens, completion_tokens,
                    total_tokens, cost_usd, error
                }
            }
        },
        "elapsed_s": float,
        "query_count": int,
        "model_count": int,
    }
    """
    all_configs = discover_model_configs()

    # Filter to requested env files if provided
    if env_files:
        configs = [c for c in all_configs if c["_env_file"] in env_files]
    else:
        configs = all_configs

    if not configs:
        raise ValueError(
            "No model configs found. "
            "Create qa-runner/.env.model1 and .env.model2 (see POSTGRES_SETUP.md)."
        )

    t_start = time.perf_counter()

    # Build all (config, query) task pairs
    tasks: list[tuple[dict, dict]] = [
        (cfg, q) for cfg in configs for q in queries
    ]

    # ── Submit ALL tasks simultaneously — true parallel execution ────────────
    # All futures are submitted BEFORE any .result() is called.
    # Both models receive their first query at the same clock tick.
    raw: dict[tuple[str, str], dict] = {}
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(len(tasks), 16)
    ) as executor:
        # Step 1: submit everything first (non-blocking)
        future_map: dict[concurrent.futures.Future, tuple[str, str]] = {}
        for cfg, q in tasks:
            fut = executor.submit(
                _call_model_sync_timed,  # ← timed wrapper records start/end timestamps
                cfg,                     # ← config dict passed explicitly (no os.environ)
                _build_prompt(q, cfg),
                system_prompt,
            )
            future_map[fut] = (cfg["LLM_MODEL_NAME"], q["id"])

        # Step 2: collect results (blocks until each completes)
        for future, (model_id, query_id) in future_map.items():
            try:
                result = future.result(timeout=120)
            except concurrent.futures.TimeoutError:
                result = _error_result(model_id, "", "Timeout after 120s")
                result["started_at"] = result["completed_at"] = time.time()
            except Exception as e:
                result = _error_result(model_id, "", str(e))
                result["started_at"] = result["completed_at"] = time.time()
            raw[(model_id, query_id)] = result

    # Organise by model → query and attach cost
    results: dict[str, dict[str, dict]] = {}
    cfg_map = {c["LLM_MODEL_NAME"]: c for c in configs}

    for (model_id, query_id), res in raw.items():
        if model_id not in results:
            results[model_id] = {}
        cfg = cfg_map[model_id]
        res["cost_usd"] = _estimate_cost(cfg, res["prompt_tokens"], res["completion_tokens"])
        results[model_id][query_id] = res

    # Build execution trace (proves both models were called concurrently)
    execution_trace = []
    all_starts = [r.get("started_at", 0) for r in raw.values() if r.get("started_at")]
    baseline   = min(all_starts) if all_starts else t_start
    for (model_id, query_id), res in raw.items():
        execution_trace.append({
            "model":        model_id,
            "query_id":     query_id,
            "started_ms":   round((res.get("started_at",   baseline) - baseline) * 1000),
            "completed_ms": round((res.get("completed_at", baseline) - baseline) * 1000),
            "latency_ms":   res.get("latency_ms", 0),
            "error":        res.get("error"),
        })
    execution_trace.sort(key=lambda x: x["started_ms"])

    return {
        "models":          get_available_models(),
        "results":         results,
        "elapsed_s":       round(time.perf_counter() - t_start, 2),
        "query_count":     len(queries),
        "model_count":     len(configs),
        "execution_trace": execution_trace,
    }


def judge_benchmark_results(
    results: dict[str, dict[str, dict]],
    queries: list[dict],
    judge_model: str = "gpt-4o-mini",
) -> dict[str, dict]:
    """
    Explicit opt-in LLM judge pass for an existing benchmark result set.
    Never called automatically by run_prism_benchmark() — only when the client
    passes with_judge=true to POST /prism/run-compare or calls POST /prism/judge-batch.

    Returns judgments keyed as ``{model_id}||{lang}||{base_query_id}`` (matches UI).
    """
    judgments: dict[str, dict] = {}
    query_by_id = {q["id"]: q for q in queries}

    for model_id, query_map in results.items():
        for flat_id, raw in query_map.items():
            q = query_by_id.get(flat_id)
            if not q or raw.get("error"):
                continue

            parts    = flat_id.split("_")
            lang     = parts[-1] if len(parts) > 1 else q.get("language", "en")
            base_qid = "_".join(parts[:-1]) if len(parts) > 1 else flat_id
            key      = f"{model_id}||{lang}||{base_qid}"

            judgments[key] = llm_judge_single(
                question        = q.get("text", ""),
                expected_intent = q.get("expectedIntent", ""),
                actual_response = raw.get("content", ""),
                judge_model     = judge_model,
            )

    return judgments


# ── Quick ping — proves both models are called simultaneously ─────────────────

def ping_models(env_files: list[str] | None = None) -> dict:
    """
    Send one simple prompt to every configured model in parallel.
    Returns each model's response + timestamps that prove concurrent execution.
    Use this to verify both models are reachable before a full PRISM run.
    """
    configs = discover_model_configs()
    if env_files:
        configs = [c for c in configs if c["_env_file"] in env_files]
    if not configs:
        return {"error": "No model configs found.", "models": []}

    PING_PROMPT = (
        "You are a car voice assistant. In exactly one short sentence, "
        "confirm you can help with navigation, weather, and music."
    )
    wall_start = time.time()

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(configs)) as executor:
        # All futures submitted at the same instant
        futures = {
            executor.submit(_call_model_sync_timed, cfg, PING_PROMPT): cfg
            for cfg in configs
        }
        pings = []
        for fut, cfg in futures.items():
            try:
                res = fut.result(timeout=60)
            except Exception as e:
                res = _error_result(cfg["LLM_MODEL_NAME"], cfg.get("LLM_PROVIDER", ""), str(e))
                res["started_at"] = res["completed_at"] = time.time()

            baseline = wall_start
            pings.append({
                "model":          cfg["LLM_MODEL_NAME"],
                "display_name":   cfg["MODEL_DISPLAY_NAME"],
                "provider":       cfg["LLM_PROVIDER"],
                "env_file":       cfg["_env_file"],
                "started_ms_offset":   round((res.get("started_at",   baseline) - baseline) * 1000),
                "completed_ms_offset": round((res.get("completed_at", baseline) - baseline) * 1000),
                "latency_ms":     res.get("latency_ms", 0),
                "response":       res.get("content", "")[:300],   # trim long responses
                "tokens_used":    res.get("total_tokens", 0),
                "error":          res.get("error"),
                "status":         "ok" if not res.get("error") else "error",
            })

    pings.sort(key=lambda x: x["started_ms_offset"])
    return {
        "wall_start_unix": wall_start,
        "total_elapsed_ms": round((time.time() - wall_start) * 1000),
        "model_count": len(pings),
        "pings": pings,
        "note": (
            "started_ms_offset values close to 0 prove both models fired at the same time. "
            "completed_ms_offset = when the API responded (overlap = true parallelism)."
        ),
    }


def _build_prompt(query: dict, config: dict) -> str:
    """
    Build the user-facing prompt for a query.
    Prepends language context if language != 'en'.
    """
    lang = query.get("language", "en")
    text = query.get("text", "")
    if lang and lang != "en":
        return f"[Language: {lang}] {text}"
    return text


# ── LLM-as-Judge ─────────────────────────────────────────────────────────────

_JUDGE_SYSTEM = """\
You are an impartial evaluator for CARA, a car voice assistant.

Given:
  • user_question    — what the user asked
  • expected_intent  — the capability the assistant should have exercised
                       (e.g. get_current_weather, get_locale_time, navigation)
  • actual_response  — what the assistant actually replied

Your job: decide whether the assistant's response CORRECTLY and HELPFULLY
answered the user's question, regardless of how the response is worded.

Rules:
  1. Focus on whether the question was answered — not on exact phrasing.
  2. A response that says "I cannot do that right now" for a capability that
     should work is INCORRECT.
  3. A partial answer that covers the main point but misses a minor detail
     is "partial".
  4. If the response is in a language different from English but still answers
     the question correctly, it is still CORRECT.

Respond ONLY with a valid JSON object (no markdown fences), for example:
{"verdict":"correct","confidence":0.92,"explanation":"The assistant gave the current weather for the requested city."}

verdict must be one of: "correct", "incorrect", "partial"
confidence must be a float 0.0–1.0
explanation must be a single sentence."""


def llm_judge_single(
    question:        str,
    expected_intent: str,
    actual_response: str,
    judge_model:     str = "gpt-4o-mini",
    api_key:         str = "",
    base_url:        str = "https://api.openai.com/v1",
) -> dict:
    """
    Ask an LLM to grade one (question, expected_intent, actual_response) triple.

    Returns
    -------
    {
        "verdict":     "correct" | "incorrect" | "partial",
        "confidence":  float,
        "explanation": str,
        "error":       str | None,
    }
    """
    if not api_key:
        api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        return {
            "verdict":     "unknown",
            "confidence":  0.0,
            "explanation": "No OPENAI_API_KEY available for the judge.",
            "error":       "no_api_key",
        }

    user_msg = (
        f"user_question:   {question}\n"
        f"expected_intent: {expected_intent}\n"
        f"actual_response: {actual_response}"
    )

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                f"{base_url.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type":  "application/json",
                },
                json={
                    "model":           judge_model,
                    "messages": [
                        {"role": "system", "content": _JUDGE_SYSTEM},
                        {"role": "user",   "content": user_msg},
                    ],
                    "temperature":     0,
                    "response_format": {"type": "json_object"},
                },
            )
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"]
            parsed = json.loads(raw)
            return {
                "verdict":     parsed.get("verdict",     "unknown"),
                "confidence":  float(parsed.get("confidence", 0.0)),
                "explanation": parsed.get("explanation", ""),
                "error":       None,
            }
    except Exception as exc:
        return {
            "verdict":     "unknown",
            "confidence":  0.0,
            "explanation": "",
            "error":       str(exc),
        }
