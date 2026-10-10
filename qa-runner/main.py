"""CARA QA Runner API — triggers voice E2E regression and serves results to the React dashboard.

Improvements over v1:
  - Suite stdout/stderr now stored in run metadata → visible in dashboard for debugging
  - /runs/{run_id} response includes per-suite errors surface for quick diagnosis
  - Suite-level errors no longer swallow the whole run — partial results still written
  - /runs endpoint returns up to 50 recent runs (was 20)
  - Added /runs/{run_id}/suites endpoint for per-suite status breakdown
  - Health endpoint also reports Python interpreter and QA runner root
  - PostgreSQL persistence: /db/* endpoints for saving and loading runs + PRISM results
  - PRD analysis: /prd/* endpoints — extract requirements and generate test cases from a PRD doc
"""

from __future__ import annotations

import json
import os
import sys
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, List, Optional

import io
import queue as _queue

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from runner import (
    DEFAULT_SMOKE_SUITES,
    discover_suites,
    execute_run,
    get_cara_backend_path,
    load_suite_env,
    runs_dir,
)

# DB service — optional; gracefully disabled if asyncpg is not installed or DB unreachable
try:
    from db_service import db as _db
    _DB_ENABLED = True
except ImportError:
    _db = None  # type: ignore
    _DB_ENABLED = False

load_suite_env()

app = FastAPI(title="CARA QA Runner", version="2.1.0")


# ── DB lifecycle ──────────────────────────────────────────────────────────────

@app.on_event("startup")
async def _startup():
    if _DB_ENABLED:
        try:
            await _db.connect()
        except Exception as exc:
            print(f"[DB] WARNING: Could not connect to PostgreSQL — {exc}")
            print("[DB] DB endpoints will return 503. Set CARA_DB_DSN to enable persistence.")


@app.on_event("shutdown")
async def _shutdown():
    if _DB_ENABLED and _db._pool:
        await _db.disconnect()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:5175",
        "http://127.0.0.1:5175",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory run registry (persisted to disk per run via meta.json)
_runs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


# ── Request model ─────────────────────────────────────────────────────────────

class StartRunRequest(BaseModel):
    environment: str = "local"
    base_url: str = Field(default="", alias="baseUrl")
    suites: list[str] = Field(default_factory=lambda: list(DEFAULT_SMOKE_SUITES))

    model_config = {"populate_by_name": True}


# ── Run persistence helpers ───────────────────────────────────────────────────

def _run_dir(run_id: str) -> Path:
    return runs_dir() / run_id


def _load_run(run_id: str) -> dict[str, Any] | None:
    with _lock:
        if run_id in _runs:
            return _runs[run_id]

    meta_path = _run_dir(run_id) / "meta.json"
    if not meta_path.is_file():
        return None
    data = json.loads(meta_path.read_text(encoding="utf-8"))
    with _lock:
        _runs[run_id] = data
    return data


def _save_run(run_id: str, data: dict[str, Any]) -> None:
    run_path = _run_dir(run_id)
    run_path.mkdir(parents=True, exist_ok=True)
    (run_path / "meta.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    with _lock:
        _runs[run_id] = data


def _merge_results(run_id: str) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    run_path = _run_dir(run_id)
    for suite_dir in sorted(run_path.iterdir()):
        if not suite_dir.is_dir():
            continue
        results_file = suite_dir / "results.json"
        if not results_file.is_file():
            continue
        payload = json.loads(results_file.read_text(encoding="utf-8"))
        for case in payload.get("cases", []):
            case["suite"] = suite_dir.name
            merged.append(case)
    merged_path = run_path / "results.json"
    merged_path.write_text(
        json.dumps({"run_id": run_id, "cases": merged}, indent=2),
        encoding="utf-8",
    )
    return merged


def _build_report_html(run_id: str, cases: list[dict[str, Any]], meta: dict[str, Any]) -> str:
    passed = sum(1 for c in cases if c.get("status") == "PASS")
    failed = len(cases) - passed
    pct = round(passed / len(cases) * 100, 1) if cases else 0

    rows = []
    for c in cases:
        status = c.get("status", "FAIL")
        color = "#16a34a" if status == "PASS" else "#dc2626"
        rows.append(
            f"<tr>"
            f"<td>{c.get('suite', '')}</td>"
            f"<td>{c.get('case_id', '')}</td>"
            f"<td style='color:{color};font-weight:600'>{status}</td>"
            f"<td>{c.get('accuracy_percent', '')}%</td>"
            f"<td>{_escape(c.get('input', ''))}</td>"
            f"<td>{_escape(c.get('output', ''))}</td>"
            f"<td>{_escape(c.get('error', '') or '')}</td>"
            f"</tr>"
        )

    suite_error_rows = ""
    for sr in meta.get("suite_results", []):
        if sr.get("error"):
            suite_error_rows += (
                f"<tr><td>{_escape(sr.get('suite',''))}</td>"
                f"<td colspan='2' style='color:#dc2626'>{_escape(sr['error'][:500])}</td></tr>"
            )

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>CARA Run {run_id}</title>
<style>
  body {{ font-family: system-ui, sans-serif; margin: 24px; background: #f8fafc; }}
  h1, h2 {{ color: #0f172a; }}
  .summary {{ display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }}
  .card {{ background: white; padding: 16px 24px; border-radius: 8px;
           box-shadow: 0 1px 3px rgba(0,0,0,.1); min-width: 80px; }}
  .card b {{ display: block; font-size: 22px; }}
  table {{ width: 100%; border-collapse: collapse; background: white; margin-bottom: 24px; }}
  th, td {{ border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; vertical-align: top; }}
  th {{ background: #1e293b; color: white; }}
</style></head><body>
<h1>CARA Regression Report</h1>
<p>Run <strong>{run_id}</strong> · {meta.get('environment', '')} · {meta.get('base_url', '')}</p>
<p>Generated {meta.get('finished_at', meta.get('started_at', ''))}</p>
<div class="summary">
  <div class="card"><b>{len(cases)}</b>Total</div>
  <div class="card" style="color:#16a34a"><b>{passed}</b>Passed</div>
  <div class="card" style="color:#dc2626"><b>{failed}</b>Failed</div>
  <div class="card"><b>{pct}%</b>Pass rate</div>
</div>
<table>
  <thead><tr><th>Suite</th><th>Case</th><th>Status</th><th>Accuracy</th>
  <th>Input</th><th>Output</th><th>Error / Note</th></tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table>
{"<h2>Suite Execution Errors</h2><table><thead><tr><th>Suite</th><th colspan='2'>Error</th></tr></thead><tbody>" + suite_error_rows + "</tbody></table>" if suite_error_rows else ""}
</body></html>"""


def _escape(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# ── Background runner ─────────────────────────────────────────────────────────

def _run_in_background(run_id: str, base_url: str, suites: list[str]) -> None:
    meta = _load_run(run_id) or {}
    meta["status"] = "running"
    meta["current_suite"] = None
    _save_run(run_id, meta)

    suite_results: list[dict[str, Any]] = []
    errors: list[str] = []

    for i, suite_id in enumerate(suites):
        meta = _load_run(run_id) or {}
        meta["current_suite"] = suite_id
        meta["progress"] = {"completed": i, "total": len(suites)}
        _save_run(run_id, meta)

        output_dir = _run_dir(run_id) / suite_id
        result = execute_run(suite_id=suite_id, base_url=base_url, output_dir=output_dir)
        suite_results.append(result)

        if result.get("error"):
            errors.append(f"{suite_id}: {result['error']}")

    cases = _merge_results(run_id)
    passed = sum(1 for c in cases if c.get("status") == "PASS")
    failed = len(cases) - passed

    meta = _load_run(run_id) or {}
    # Mark as "done" even with partial errors so the dashboard shows results.
    # Only mark "failed" when there are NO cases at all (complete breakdown).
    meta["status"] = "failed" if (errors and not cases) else "done"
    meta["current_suite"] = None
    meta["finished_at"] = datetime.now(UTC).isoformat()
    meta["summary"] = {
        "total": len(cases),
        "passed": passed,
        "failed": failed,
        "pass_rate_pct": round(passed / len(cases) * 100, 1) if cases else 0,
        "suite_errors": errors,
    }
    meta["progress"] = {"completed": len(suites), "total": len(suites)}
    # Store suite results with stdout/stderr for debugging
    meta["suite_results"] = [
        {
            "suite": r.get("suite"),
            "error": r.get("error"),
            "returncode": r.get("returncode"),
            # Truncate to keep meta.json readable
            "stderr_tail": (r.get("stderr") or "")[-500:],
        }
        for r in suite_results
    ]
    _save_run(run_id, meta)

    report_html = _build_report_html(run_id, cases, meta)
    (_run_dir(run_id) / "report.html").write_text(report_html, encoding="utf-8")


# ── API routes ────────────────────────────────────────────────────────────────

_INTENT_MAP_SEARCH_PATHS = [
    Path(__file__).resolve().parent.parent / "agent_tool_intent_map.json",
    Path.home() / "Downloads" / "agent_tool_intent_map.json",
    Path(__file__).resolve().parent / "agent_tool_intent_map.json",
]


@app.get("/intent-map")
def get_intent_map():
    """Return the canonical agent_tool_intent_map.json for the regression dashboard.

    This is used by the frontend to:
    - Show which backend tool was called per test case.
    - Detect misrouting (wrong tool used for an intent).
    - Auto-populate intent aliases in the evaluator.
    """
    env_path = os.environ.get("CARA_INTENT_MAP_PATH", "").strip()
    candidates = ([Path(env_path)] if env_path else []) + _INTENT_MAP_SEARCH_PATHS
    for p in candidates:
        if p.exists():
            return FileResponse(str(p), media_type="application/json")
    raise HTTPException(
        status_code=404,
        detail=(
            "agent_tool_intent_map.json not found. "
            "Set CARA_INTENT_MAP_PATH env var or place the file alongside this server. "
            f"Searched: {[str(c) for c in candidates]}"
        ),
    )


@app.get("/health")
def health():
    backend = get_cara_backend_path()
    return {
        "status": "ok",
        "version": "2.0.0",
        "cara_backend": str(backend),
        "cara_backend_exists": backend.is_dir(),
        "python": sys.executable,
        "qa_runner_root": str(Path(__file__).resolve().parent),
    }


@app.get("/suites")
def list_suites():
    return discover_suites()


@app.get("/environments")
def list_environments():
    return [
        {"id": "local", "name": "Local", "baseUrl": "http://127.0.0.1:9090"},
        {
            "id": "uat",
            "name": "UAT",
            "baseUrl": os.environ.get("CARA_UAT_BASE_URL", "http://127.0.0.1:9090"),
        },
    ]


@app.post("/runs")
def start_run(body: StartRunRequest):
    backend = get_cara_backend_path()
    if not backend.is_dir():
        raise HTTPException(
            status_code=503,
            detail=(
                f"CARA backend not found at {backend}. "
                "Set the CARA_BACKEND_PATH environment variable to the correct path."
            ),
        )

    run_id = str(uuid.uuid4())[:8]
    base_url = body.base_url.strip() or "http://127.0.0.1:9090"

    meta: dict[str, Any] = {
        "run_id": run_id,
        "status": "queued",
        "environment": body.environment,
        "base_url": base_url,
        "suites": body.suites,
        "started_at": datetime.now(UTC).isoformat(),
        "finished_at": None,
        "current_suite": None,
        "progress": {"completed": 0, "total": len(body.suites)},
        "summary": None,
        "suite_results": [],
    }
    _save_run(run_id, meta)

    thread = threading.Thread(
        target=_run_in_background,
        args=(run_id, base_url, body.suites),
        daemon=True,
    )
    thread.start()

    return {"runId": run_id, "status": "queued"}


@app.get("/runs/{run_id}")
def get_run(run_id: str):
    meta = _load_run(run_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return {
        "runId": run_id,
        "status": meta.get("status"),
        "environment": meta.get("environment"),
        "baseUrl": meta.get("base_url"),
        "suites": meta.get("suites", []),
        "currentSuite": meta.get("current_suite"),
        "progress": meta.get("progress"),
        "summary": meta.get("summary"),
        "startedAt": meta.get("started_at"),
        "finishedAt": meta.get("finished_at"),
    }


@app.get("/runs/{run_id}/suites")
def get_run_suite_breakdown(run_id: str):
    """Per-suite execution status — useful for debugging which suite failed."""
    meta = _load_run(run_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return {
        "runId": run_id,
        "status": meta.get("status"),
        "suiteResults": meta.get("suite_results", []),
    }


@app.get("/runs/{run_id}/results")
def get_run_results(run_id: str):
    meta = _load_run(run_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Run not found")

    results_path = _run_dir(run_id) / "results.json"
    if results_path.is_file():
        payload = json.loads(results_path.read_text(encoding="utf-8"))
        return payload.get("cases", [])

    if meta.get("status") in ("queued", "running"):
        return []

    raise HTTPException(status_code=404, detail="Results not available yet")


@app.get("/runs/{run_id}/report")
def get_run_report(run_id: str):
    meta = _load_run(run_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Run not found")

    report_path = _run_dir(run_id) / "report.html"
    if not report_path.is_file():
        raise HTTPException(status_code=404, detail="Report not ready")
    return FileResponse(report_path, media_type="text/html")


@app.get("/runs")
def list_runs():
    root = runs_dir()
    if not root.is_dir():
        return []
    items = []
    for path in sorted(root.iterdir(), reverse=True):
        if not path.is_dir():
            continue
        meta_path = path / "meta.json"
        if not meta_path.is_file():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        summary = meta.get("summary") or {}
        items.append(
            {
                "runId": meta.get("run_id", path.name),
                "status": meta.get("status"),
                "environment": meta.get("environment"),
                "startedAt": meta.get("started_at"),
                "summary": {
                    **summary,
                    # Ensure pass_rate_pct is always present for the dashboard
                    "pass_rate_pct": summary.get("pass_rate_pct")
                    or (
                        round(summary["passed"] / summary["total"] * 100, 1)
                        if summary.get("total")
                        else 0
                    ),
                },
            }
        )
    return items[:50]


# ── DB helper ─────────────────────────────────────────────────────────────────

def _require_db():
    if not _DB_ENABLED or _db is None:
        raise HTTPException(
            status_code=503,
            detail="Database not available. Run: pip install asyncpg  and set DATABASE_URL in qa-runner/.env"
        )
    if _db._pool is None:
        raise HTTPException(
            status_code=503,
            detail="PostgreSQL not reachable. Run: cd qa-runner && docker-compose up -d"
        )


# ── Pydantic models for DB requests ───────────────────────────────────────────

class SaveTestRunRequest(BaseModel):
    run_label:    Optional[str]  = None
    project_name: str            = "CARA"
    backend_url:  Optional[str]  = None
    brand:        Optional[str]  = None
    total:        int            = 0
    passed:       int            = 0
    failed:       int            = 0
    started_at:   Optional[str]  = None
    finished_at:  Optional[str]  = None
    duration_ms:  Optional[int]  = None
    config:       Optional[dict] = None
    results:      Optional[List[dict]] = None   # array of per-TC result objects


class SavePrismRunRequest(BaseModel):
    run_label:    Optional[str]       = None
    project_name: str                 = "CARA"
    backend_url:  Optional[str]       = None
    models:       Optional[List[dict]] = None
    languages:    Optional[List[str]] = None
    query_count:  int                 = 0
    started_at:   Optional[str]       = None
    finished_at:  Optional[str]       = None
    duration_ms:  Optional[int]       = None
    config:       Optional[dict]      = None
    results:      Optional[List[dict]] = None   # flat list of prism_result rows


# ── Test Run DB endpoints ──────────────────────────────────────────────────────

@app.post("/db/test-runs")
async def db_save_test_run(body: SaveTestRunRequest):
    """Persist a completed regression run and its results to PostgreSQL."""
    _require_db()
    from datetime import timezone
    def _parse(dt):
        return datetime.fromisoformat(dt) if dt else None

    run_id = await _db.save_test_run(
        run_label    = body.run_label,
        project_name = body.project_name,
        backend_url  = body.backend_url,
        brand        = body.brand,
        total        = body.total,
        passed       = body.passed,
        failed       = body.failed,
        started_at   = _parse(body.started_at),
        finished_at  = _parse(body.finished_at),
        duration_ms  = body.duration_ms,
        config       = body.config,
    )
    if body.results:
        await _db.save_test_results(run_id, body.results)
    return {"run_id": run_id, "saved": True}


@app.get("/db/test-runs")
async def db_list_test_runs(limit: int = 50):
    """Return the most recent regression runs stored in PostgreSQL."""
    _require_db()
    runs = await _db.list_test_runs(limit=limit)
    return runs


@app.get("/db/test-runs/{run_id}")
async def db_get_test_run(run_id: str):
    _require_db()
    run = await _db.get_test_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found in database")
    return run


@app.get("/db/test-runs/{run_id}/results")
async def db_get_test_run_results(run_id: str):
    _require_db()
    return await _db.get_test_run_results(run_id)


# ── PRISM DB endpoints ────────────────────────────────────────────────────────

@app.post("/db/prism-runs")
async def db_save_prism_run(body: SavePrismRunRequest):
    """Persist a completed PRISM benchmark run to PostgreSQL."""
    _require_db()
    def _parse(dt):
        return datetime.fromisoformat(dt) if dt else None

    run_id = await _db.save_prism_run(
        run_label    = body.run_label,
        project_name = body.project_name,
        backend_url  = body.backend_url,
        models       = body.models,
        languages    = body.languages,
        query_count  = body.query_count,
        started_at   = _parse(body.started_at),
        finished_at  = _parse(body.finished_at),
        duration_ms  = body.duration_ms,
        config       = body.config,
    )
    if body.results:
        await _db.save_prism_results(run_id, body.results)
    return {"run_id": run_id, "saved": True}


@app.get("/db/prism-runs")
async def db_list_prism_runs(limit: int = 50):
    _require_db()
    return await _db.list_prism_runs(limit=limit)


@app.get("/db/prism-runs/{run_id}")
async def db_get_prism_run(run_id: str):
    _require_db()
    run = await _db.get_prism_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="PRISM run not found in database")
    return run


@app.get("/db/prism-runs/{run_id}/results")
async def db_get_prism_run_results(run_id: str):
    _require_db()
    return await _db.get_prism_run_results(run_id)


@app.get("/db/prism-runs/{run_id}/accuracy")
async def db_get_prism_accuracy(run_id: str):
    """Aggregated accuracy per (model, language) for a PRISM run."""
    _require_db()
    return await _db.get_prism_model_lang_accuracy(run_id)


# ── Languages & Intent Map endpoints ─────────────────────────────────────────

@app.get("/db/languages")
async def db_get_languages():
    _require_db()
    return await _db.get_languages()


@app.get("/db/intent-map")
async def db_get_intent_map():
    _require_db()
    return await _db.get_intent_map()


@app.post("/db/intent-map/sync")
async def db_sync_intent_map():
    """Sync agent_tool_intent_map.json → intent_tool_map table."""
    _require_db()
    map_path = _find_intent_map()
    if not map_path or not map_path.is_file():
        raise HTTPException(status_code=404, detail="agent_tool_intent_map.json not found")
    raw = json.loads(map_path.read_text(encoding="utf-8"))
    entries = []
    for intent, info in raw.items():
        entries.append({
            "intent":        intent,
            "tool":          info.get("tool"),
            "handler":       info.get("handler"),
            "backend_types": info.get("backendTypes") or info.get("backend_types") or [],
            "description":   info.get("description"),
        })
    await _db.upsert_intent_map(entries)
    return {"synced": len(entries)}


@app.get("/db/health")
async def db_health():
    if not _DB_ENABLED:
        return {"status": "disabled", "reason": "asyncpg not installed"}
    if _db._pool is None:
        return {"status": "disconnected"}
    ok = await _db.ping()
    return {"status": "ok" if ok else "error"}


# ── PRISM parallel benchmark endpoints ───────────────────────────────────────

try:
    from prism_runner import (
        get_available_models as _prism_get_models,
        run_prism_benchmark  as _prism_run,
        ping_models          as _prism_ping,
        llm_judge_single     as _prism_llm_judge,
        judge_benchmark_results as _prism_judge_batch,
    )
    _PRISM_RUNNER_ENABLED = True
except ImportError:
    _PRISM_RUNNER_ENABLED = False


class PrismQuery(BaseModel):
    id:               str
    text:             str
    language:         str  = "en"
    expectedIntent:   str  = ""
    expectedResponse: str  = ""


class PrismRunRequest(BaseModel):
    queries:       List[PrismQuery]
    env_files:     Optional[List[str]] = None   # e.g. [".env.model1", ".env.model2"]
    system_prompt: str = ""
    # Explicit opt-in only — benchmark never chains judge unless this is true.
    with_judge:    bool = False
    judge_model:   str  = "gpt-4o-mini"


class PrismJudgeBatchRequest(BaseModel):
    """Explicit bulk judge — standalone; never auto-invoked by /prism/run-compare."""
    results:       dict
    queries:       List[PrismQuery]
    judge_model:   str = "gpt-4o-mini"


class PrismJudgeRequest(BaseModel):
    question:        str
    expected_intent: str
    actual_response: str
    judge_model:     str = "gpt-4o-mini"


def _require_prism_runner():
    if not _PRISM_RUNNER_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="prism_runner module failed to import — check qa-runner logs.",
        )


@app.get("/prism/ping-models")
async def prism_ping_models():
    """
    Fire one simple prompt to every configured model simultaneously and return:
      - each model's response
      - started_ms_offset / completed_ms_offset (proves concurrent execution)
      - latency, token usage, errors

    Use this to verify both models are reachable BEFORE a full PRISM run.
    GET /prism/ping-models
    """
    _require_prism_runner()
    import asyncio
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _prism_ping)
    return result


@app.get("/prism/models")
def prism_get_models():
    """
    Return the list of models discovered from .env.model* files.
    No dummy/hardcoded models — only what is actually configured.
    """
    _require_prism_runner()
    return {"models": _prism_get_models()}


@app.post("/prism/run-compare")
async def prism_run_compare(body: PrismRunRequest):
    """
    Run all queries against all configured models in parallel (ThreadPoolExecutor).
    Each model's credentials come from its own .env.modelN file via dotenv_values()
    — os.environ is never mutated.

    POST body:
    {
      "queries": [
        { "id": "q1", "text": "Navigate to MG Road", "language": "en",
          "expectedIntent": "navigation", "expectedResponse": "" }
      ],
      "env_files": [".env.model1", ".env.model2"],   // optional filter
      "system_prompt": ""                             // optional
    }
    """
    _require_prism_runner()
    if not body.queries:
        raise HTTPException(status_code=400, detail="queries list is empty")

    import asyncio
    loop = asyncio.get_event_loop()
    # run_prism_benchmark is CPU+network bound — run in executor so we don't block the event loop
    result = await loop.run_in_executor(
        None,
        lambda: _prism_run(
            queries    = [q.model_dump() for q in body.queries],
            env_files  = body.env_files or None,
            system_prompt = body.system_prompt,
        ),
    )
    # Judge is opt-in only — never chained unless with_judge=true on the request.
    if body.with_judge:
        result["judgments"] = await loop.run_in_executor(
            None,
            lambda: _prism_judge_batch(
                results     = result["results"],
                queries     = [q.model_dump() for q in body.queries],
                judge_model = body.judge_model,
            ),
        )
    return result


@app.post("/prism/judge-batch")
async def prism_judge_batch(body: PrismJudgeBatchRequest):
    """
    Standalone bulk LLM judge for an existing benchmark result set.
    Does not re-run the benchmark. Invoke explicitly (UI: Judge All button).
    """
    _require_prism_runner()
    import asyncio
    loop = asyncio.get_event_loop()
    judgments = await loop.run_in_executor(
        None,
        lambda: _prism_judge_batch(
            results     = body.results,
            queries     = [q.model_dump() for q in body.queries],
            judge_model = body.judge_model,
        ),
    )
    return {"judgments": judgments, "count": len(judgments)}


@app.post("/prism/judge")
async def prism_judge(body: PrismJudgeRequest):
    """
    Ask an LLM to grade a single (question, expected_intent, actual_response) triple.

    Returns:
    {
        "verdict":     "correct" | "incorrect" | "partial",
        "confidence":  float,
        "explanation": str,
        "error":       str | None
    }

    Used by the PRISM Raw Responses tab to provide a second-opinion when the
    keyword heuristic classification looks wrong. Also used for bulk "Judge All".
    Uses OPENAI_API_KEY from the qa-runner .env for the judge model.
    """
    _require_prism_runner()
    import asyncio
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        lambda: _prism_llm_judge(
            question        = body.question,
            expected_intent = body.expected_intent,
            actual_response = body.actual_response,
            judge_model     = body.judge_model,
        ),
    )
    return result


# ── PRD Analysis endpoints ────────────────────────────────────────────────────

try:
    from prd_service import extract_requirements, generate_test_cases, prd_to_test_cases
    _PRD_ENABLED = True
except ImportError:
    _PRD_ENABLED = False


class PrdExtractRequest(BaseModel):
    prd_text: str = Field(..., alias="prdText")
    model_config = {"populate_by_name": True}


class PrdGenerateTCRequest(BaseModel):
    requirements: list[dict]


class PrdPipelineRequest(BaseModel):
    prd_text: str = Field(..., alias="prdText")
    # Combined extract+generate is opt-in only. Default: use separate endpoints.
    allow_combined_pipeline: bool = Field(False, alias="allowCombinedPipeline")
    model_config = {"populate_by_name": True}


def _require_prd():
    if not _PRD_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="prd_service is unavailable. Ensure httpx is installed: pip install httpx",
        )
    import os
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY is not set. Add it to qa-runner/.env to enable PRD analysis.",
        )


@app.post("/prd/extract-requirements")
async def prd_extract_requirements(body: PrdExtractRequest):
    """
    Step 1: Extract structured requirements from raw PRD text.
    POST body: { "prdText": "<full PRD content>" }
    Returns: { "requirements": [...], "count": N }
    """
    _require_prd()
    if not body.prd_text or len(body.prd_text.strip()) < 50:
        raise HTTPException(status_code=400, detail="prdText must be at least 50 characters")
    reqs = await extract_requirements(body.prd_text)
    return {"requirements": reqs, "count": len(reqs)}


@app.post("/prd/generate-test-cases")
async def prd_generate_test_cases(body: PrdGenerateTCRequest):
    """
    Step 2: Generate test cases from a requirements list.
    POST body: { "requirements": [...] }
    Returns: { "test_cases": [...], "count": N }
    """
    _require_prd()
    if not body.requirements:
        raise HTTPException(status_code=400, detail="requirements list is empty")
    tcs = await generate_test_cases(body.requirements)
    return {"test_cases": tcs, "count": len(tcs)}


@app.post("/prd/pipeline")
async def prd_full_pipeline(body: PrdPipelineRequest):
    """
    One-shot pipeline: PRD text → requirements + test cases (OpenAI only).
    Does NOT run regression / CARA agent calls.

  Opt-in only — pass allowCombinedPipeline=true, or use the separate endpoints:
    POST /prd/extract-requirements
    POST /prd/generate-test-cases
    """
    _require_prd()
    if not body.allow_combined_pipeline:
        raise HTTPException(
            status_code=400,
            detail=(
                "Combined PRD pipeline is opt-in only. "
                "Set allowCombinedPipeline=true, or call /prd/extract-requirements "
                "and /prd/generate-test-cases separately."
            ),
        )
    if not body.prd_text or len(body.prd_text.strip()) < 50:
        raise HTTPException(status_code=400, detail="prdText must be at least 50 characters")
    result = await prd_to_test_cases(body.prd_text)
    return result


# ── Judge LLM Evaluation (standalone — report returned to UI, not CARA BE) ───

try:
    from config_loader import get_config_summary, load_judge_settings
    from judge_runner import run_judge_evaluation
    from judge_report import build_allure_payload, format_report
    _JUDGE_ENABLED = True
except ImportError as _judge_import_err:
    _JUDGE_ENABLED = False
    _judge_import_err  # noqa: F841


class JudgeTestCase(BaseModel):
    id: Optional[str] = None
    tcId: Optional[str] = None
    input: Optional[str] = None
    voice_input: Optional[str] = None
    expectedIntent: Optional[str] = None
    expectedResponse: Optional[str] = None
    expected_intent: Optional[str] = None
    expected_response: Optional[str] = None
    module: Optional[str] = None
    sessionId: Optional[str] = None
    flow: Optional[str] = None
    language: Optional[str] = None
    actualResult: Optional[str] = None
    actual_result: Optional[str] = None
    model_config = {"extra": "allow"}


class JudgeRunRequest(BaseModel):
    test_cases: List[JudgeTestCase] = Field(..., alias="testCases")
    cara_base_url: Optional[str] = Field(None, alias="caraBaseUrl")
    brand: Optional[str] = None
    device_id: Optional[str] = Field(None, alias="deviceId")
    with_executor: bool = Field(True, alias="withExecutor")
    report_format: Optional[str] = Field(None, alias="reportFormat")
    requirement_doc_text: Optional[str] = Field(None, alias="requirementDocText")
    model_config = {"populate_by_name": True}


def _require_judge():
    if not _JUDGE_ENABLED:
        raise HTTPException(status_code=503, detail="Judge LLM module not available")


@app.get("/judge/config")
async def judge_config():
    """Executor / judge model metadata and thresholds (no secrets)."""
    _require_judge()
    return get_config_summary()


def _parse_pdf_bytes(content: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader  # type: ignore
        except ImportError:
            raise HTTPException(status_code=422, detail="PDF parsing not available — install pypdf")
    reader = PdfReader(io.BytesIO(content))
    return "\n\n".join(page.extract_text() or "" for page in reader.pages)


def _parse_docx_bytes(content: bytes) -> str:
    try:
        from docx import Document  # type: ignore
    except ImportError:
        raise HTTPException(status_code=422, detail="DOCX parsing not available — install python-docx")
    doc = Document(io.BytesIO(content))
    return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())


@app.post("/judge/parse-requirement-doc")
async def parse_requirement_doc(file: UploadFile = File(...)):
    """Parse a PDF, DOCX, or TXT requirement document and return extracted text."""
    content = await file.read()
    name = (file.filename or "").lower()

    if name.endswith(".txt"):
        text = content.decode("utf-8", errors="replace")
    elif name.endswith(".pdf"):
        text = _parse_pdf_bytes(content)
    elif name.endswith(".docx"):
        text = _parse_docx_bytes(content)
    else:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Upload a PDF, DOCX, or TXT file.",
        )

    word_count = len(text.split())
    return {
        "text": text,
        "name": file.filename,
        "size": len(content),
        "word_count": word_count,
    }


@app.post("/judge/run-evaluation-stream")
async def judge_run_evaluation_stream(body: JudgeRunRequest):
    """
    SSE streaming version of /judge/run-evaluation.
    Emits one event per test-case completion so the UI can show live progress.
    Event types: start | progress | phase | complete | error
    """
    _require_judge()
    if not body.test_cases:
        raise HTTPException(status_code=400, detail="testCases must not be empty")

    cases = [tc.model_dump(exclude_none=True) for tc in body.test_cases]
    total = len(cases)
    q: _queue.Queue = _queue.Queue()

    def _run():
        try:
            q.put({"type": "start", "total": total})

            def on_progress(done: int, tot: int, row: dict) -> None:
                q.put({
                    "type": "progress",
                    "done": done,
                    "total": tot,
                    "tc_id": row.get("tc_id") or "",
                    "test_scenario": (row.get("test_scenario") or "")[:120],
                    "status": row.get("status") or "Fail",
                    "consolidated_percentage": row.get("consolidated_percentage") or 0,
                    "accuracy": row.get("accuracy") or 0,
                    "intent": row.get("intent") or 0,
                    "efficiency": row.get("efficiency") or 0,
                })

            result = run_judge_evaluation(
                test_cases=cases,
                cara_base_url=body.cara_base_url,
                brand=body.brand,
                device_id=body.device_id,
                with_executor=body.with_executor,
                requirement_doc_text=body.requirement_doc_text or "",
                on_progress=on_progress,
            )

            q.put({"type": "phase", "message": "Generating report…"})

            settings = load_judge_settings()
            fmt = body.report_format or settings.get("report_format", "html")
            report = format_report(result["rows"], result["summary"], result.get("meta"), fmt)
            allure = build_allure_payload(result["rows"], result["summary"], result.get("meta"))
            full = {**result, "allure": allure, "download": report}
            q.put({"type": "complete", "payload": full})
        except Exception as exc:
            q.put({"type": "error", "message": str(exc)})

    threading.Thread(target=_run, daemon=True).start()

    async def _event_gen():
        import asyncio
        idle_ticks = 0
        while True:
            try:
                event = q.get_nowait()
                idle_ticks = 0
                yield f"data: {json.dumps(event)}\n\n"
                if event["type"] in ("complete", "error"):
                    break
            except _queue.Empty:
                idle_ticks += 1
                if idle_ticks > 3000:          # 5-minute hard timeout (100 ms × 3000)
                    yield f"data: {json.dumps({'type': 'error', 'message': 'Evaluation timed out'})}\n\n"
                    break
                await asyncio.sleep(0.1)

    return StreamingResponse(
        _event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/judge/run-evaluation")
async def judge_run_evaluation(body: JudgeRunRequest):
    """
    Parallel Judge LLM evaluation:
      Branch A — executor (5.4 Nano via .env.executor) → actual result
      Branch B — judge (5.4 Mini via .env.judge) → enhanced expected + scoring

    Returns full report to the UI. Does NOT modify CARA BE or disturb regression state.
    """
    _require_judge()
    if not body.test_cases:
        raise HTTPException(status_code=400, detail="testCases must not be empty")

    import asyncio

    cases = [tc.model_dump(exclude_none=True) for tc in body.test_cases]
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        lambda: run_judge_evaluation(
            test_cases=cases,
            cara_base_url=body.cara_base_url,
            brand=body.brand,
            device_id=body.device_id,
            with_executor=body.with_executor,
            requirement_doc_text=body.requirement_doc_text or "",
        ),
    )

    settings = load_judge_settings()
    fmt = body.report_format or settings.get("report_format", "html")
    report = format_report(
        result["rows"],
        result["summary"],
        result.get("meta"),
        fmt,
    )
    allure = build_allure_payload(result["rows"], result["summary"], result.get("meta"))

    return {
        **result,
        "allure": allure,
        "download": report,
    }


# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=3001, reload=True)
