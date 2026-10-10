"""
Judge evaluation runner — parallel Branch A (executor) + Branch B (judge enhance),
then Prompt 2 scoring. Fully decoupled; no shared mutable state between LLMs.
"""

from __future__ import annotations

import logging
import re
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

import httpx

from config_loader import get_executor_config, get_judge_config, load_judge_settings
from judge_llm_service import enhance_expected_result, score_actual_result
from judge_scoring import build_report_row, summarize_rows

logger = logging.getLogger(__name__)

VEHICLE_MODULE_RE = re.compile(r"vehicle status|execute_vehicle|vehicle command", re.I)


def _extract_requirement_context(doc_text: str, tc: dict[str, Any]) -> str:
    """Return the most relevant paragraphs from the requirement doc for this test case."""
    if not doc_text or not doc_text.strip():
        return ""

    paragraphs = [p.strip() for p in doc_text.split("\n\n") if p.strip()]
    if not paragraphs:
        return doc_text[:3000]

    # Build keyword set from module name and input text
    keywords: set[str] = set()
    for field in ("module", "input", "voice_input", "expectedIntent", "expected_intent"):
        for word in (tc.get(field) or "").lower().split():
            if len(word) > 3:
                keywords.add(word)

    if not keywords:
        return "\n\n".join(paragraphs[:4])[:3000]

    scored = sorted(
        paragraphs,
        key=lambda p: sum(1 for kw in keywords if kw in p.lower()),
        reverse=True,
    )
    top = [p for p in scored[:4] if any(kw in p.lower() for kw in keywords)]
    return ("\n\n".join(top) if top else "\n\n".join(paragraphs[:3]))[:3000]


def _tc_scenario(tc: dict[str, Any]) -> str:
    parts = [
        tc.get("id") or tc.get("tcId") or "",
        tc.get("module") or "",
        tc.get("input") or tc.get("voice_input") or "",
    ]
    return " | ".join(p for p in parts if p).strip() or "Unknown scenario"


def _tc_expected(tc: dict[str, Any]) -> str:
    intent = (tc.get("expectedIntent") or tc.get("expected_intent") or "").strip()
    response = (
        tc.get("expectedResponse")
        or tc.get("expected_response")
        or tc.get("expectedResponseBehaviour")
        or ""
    ).strip()
    if intent and response:
        return f"Intent: {intent}\nExpected Response: {response}"
    return intent or response or ""


def _branch_a_execute(
    tc: dict[str, Any],
    cara_base_url: str,
    brand: str,
    executor_cfg: dict[str, str],
    device_id: str,
    timeout: float,
) -> str:
    """Call CARA process-text — same contract as frontend regression."""
    base = cara_base_url.rstrip("/")
    text = (tc.get("input") or tc.get("voice_input") or "").strip()
    if not text:
        return "[ERROR] Empty voice input / prompt"

    model_name = executor_cfg.get("CARA_MODEL_NAME") or executor_cfg.get("LLM_MODEL_NAME")
    body: dict[str, Any] = {
        "text": text,
        "deviceId": device_id,
        "language": tc.get("language") or "en",
        "model_name": model_name,
        "timezone": tc.get("timezone") or "Asia/Kolkata",
        "latitude": tc.get("latitude") or "12.9716",
        "longitude": tc.get("longitude") or "77.5946",
        "pipeline": tc.get("pipeline") or "modular",
    }
    if tc.get("sessionId"):
        body["sessionId"] = tc["sessionId"]
    if tc.get("flow"):
        body["flow"] = tc["flow"]

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if brand:
        headers["X-Brand"] = brand

    module = tc.get("module") or ""
    if VEHICLE_MODULE_RE.search(module):
        headers["X-Vehicle-Connected"] = "true"
        headers["X-Vehicle-Backend"] = tc.get("vehicleBackend") or "cvip"
        headers["X-Vehicle-VIN"] = tc.get("vehicleVin") or "REGRESSION_VIN001"
        headers["Authorization"] = f"Bearer {tc.get('regressionVehicleToken') or 'cara-regression-mock'}"

    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(f"{base}/api/v1/process-text", json=body, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            # ProcessTextResponse fields: assistant.message, intent, type, tool_data
            assistant_msg = (data.get("assistant") or {}).get("message") or ""
            intent = data.get("intent") or ""
            parts = []
            if intent:
                parts.append(f"Intent: {intent}")
            if assistant_msg:
                parts.append(f"Response: {assistant_msg}")
            return "\n".join(parts) if parts else str(data)
    except Exception as e:
        logger.error("Executor branch failed for %s: %s", tc.get("id"), e)
        return f"[EXECUTOR ERROR] {e}"


def _process_single_test_case(
    tc: dict[str, Any],
    cara_base_url: str,
    brand: str,
    executor_cfg: dict[str, str],
    judge_cfg: dict[str, str],
    settings: dict[str, Any],
    device_id: str,
    with_executor: bool,
    requirement_doc_text: str = "",
) -> dict[str, Any]:
    scenario = _tc_scenario(tc)
    expected = _tc_expected(tc)
    timeout = float(settings.get("llm_timeout_seconds", 90))
    pass_t = float(settings.get("pass_threshold", 80))
    partial_t = float(settings.get("partial_threshold", 50))
    cara_timeout = timeout * 2

    actual = ""
    enhanced: dict[str, Any] = {}

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {}
        if with_executor:
            futures["actual"] = pool.submit(
                _branch_a_execute,
                tc,
                cara_base_url,
                brand,
                executor_cfg,
                device_id,
                cara_timeout,
            )
        requirement_context = _extract_requirement_context(requirement_doc_text, tc)
        futures["enhance"] = pool.submit(
            enhance_expected_result,
            scenario,
            expected,
            judge_cfg,
            timeout,
            requirement_context,
        )

        for key, fut in futures.items():
            try:
                if key == "actual":
                    actual = fut.result()
                else:
                    enhanced = fut.result()
            except Exception as e:
                logger.error("Branch %s failed: %s", key, e)
                if key == "actual":
                    actual = f"[EXECUTOR ERROR] {e}"
                else:
                    enhanced = {
                        "improved_expected_result": expected,
                        "reasoning": str(e),
                        "error": str(e),
                    }

    if not with_executor:
        actual = (tc.get("actualResult") or tc.get("actual_result") or "").strip()
        if not actual:
            actual = "[SKIPPED] Provide actual_result or enable with_executor"

    improved = enhanced.get("improved_expected_result") or expected

    scores = score_actual_result(
        scenario,
        improved,
        actual,
        judge_cfg,
        pass_t,
        partial_t,
        timeout,
    )

    row = build_report_row(scenario, expected, improved, actual, scores)
    row["tc_id"] = tc.get("id") or tc.get("tcId")
    row["enhancement_reasoning"] = enhanced.get("reasoning", "")
    row["enhancement"] = {
        "intent": enhanced.get("intent", ""),
        "requirement": enhanced.get("requirement", ""),
        "reasoning": enhanced.get("reasoning", ""),
    }
    if enhanced.get("error"):
        row["enhancement_error"] = enhanced["error"]
    if scores.get("error"):
        row["scoring_error"] = scores["error"]
    return row


def run_judge_evaluation(
    test_cases: list[dict[str, Any]],
    cara_base_url: str | None = None,
    brand: str | None = None,
    device_id: str | None = None,
    with_executor: bool = True,
    requirement_doc_text: str = "",
    on_progress: Callable[[int, int, dict], None] | None = None,
) -> dict[str, Any]:
    """
    Run full judge pipeline. Returns rows + summary for UI (not sent to CARA BE).
    """
    settings = load_judge_settings()
    executor_cfg = get_executor_config()
    judge_cfg = get_judge_config()

    base_url = (cara_base_url or settings.get("cara_base_url") or "http://127.0.0.1:9090").rstrip("/")
    brand_val = brand or settings.get("cara_brand") or "stellantis"
    device = device_id or f"judge-eval-{uuid.uuid4().hex[:8]}"
    max_workers = int(settings.get("max_parallel_test_cases", 4))

    if not test_cases:
        return {"rows": [], "summary": summarize_rows([]), "errors": ["No test cases provided"]}

    rows: list[dict[str, Any]] = []
    total = len(test_cases)
    completed = 0

    with ThreadPoolExecutor(max_workers=min(max_workers, total)) as pool:
        future_map = {
            pool.submit(
                _process_single_test_case,
                tc,
                base_url,
                brand_val,
                executor_cfg,
                judge_cfg,
                settings,
                device,
                with_executor,
                requirement_doc_text,
            ): tc
            for tc in test_cases
        }
        for fut in as_completed(future_map):
            tc = future_map[fut]
            try:
                row = fut.result()
            except Exception as e:
                logger.exception("Test case processing failed")
                row = build_report_row(
                    _tc_scenario(tc),
                    _tc_expected(tc),
                    _tc_expected(tc),
                    f"[PIPELINE ERROR] {e}",
                    {
                        "accuracy": 0,
                        "intent": 0,
                        "efficiency": 0,
                        "consolidated_percentage": 0,
                        "status": "Fail",
                        "accuracy_justification": str(e),
                        "intent_justification": "",
                        "efficiency_justification": "",
                    },
                )
                row["tc_id"] = tc.get("id")
            rows.append(row)
            completed += 1
            if on_progress:
                on_progress(completed, total, row)

    # Stable order by tc_id if present
    rows.sort(key=lambda r: str(r.get("tc_id") or ""))

    summary = summarize_rows(rows)
    return {
        "rows": rows,
        "summary": summary,
        "meta": {
            "executor_model": executor_cfg.get("LLM_MODEL_NAME"),
            "judge_model": judge_cfg.get("LLM_MODEL_NAME"),
            "with_executor": with_executor,
            "cara_base_url": base_url,
            "brand": brand_val,
        },
    }
