"""
Pure scoring utilities for Judge LLM evaluation — unit-testable, no I/O.
"""

from __future__ import annotations

import json
import re
from typing import Any


def consolidated_percentage(accuracy: float, intent: float, efficiency: float) -> float:
    return round((float(accuracy) + float(intent) + float(efficiency)) / 3.0, 2)


def status_from_consolidated(
    consolidated: float,
    pass_threshold: float = 80,
    partial_threshold: float = 50,
) -> str:
    if consolidated >= pass_threshold:
        return "Pass"
    if consolidated >= partial_threshold:
        return "Partial"
    return "Fail"


def extract_json_object(text: str) -> dict[str, Any]:
    """Parse JSON from LLM output, tolerating markdown fences."""
    if not text or not str(text).strip():
        raise ValueError("Empty LLM response")
    cleaned = re.sub(r"```(?:json)?\s*", "", str(text)).strip().rstrip("`").strip()
    start = next((i for i, c in enumerate(cleaned) if c in "{["), None)
    if start is None:
        raise ValueError(f"No JSON object found in: {cleaned[:200]}")
    open_c = cleaned[start]
    close_c = "}" if open_c == "{" else "]"
    depth, in_str, escape = 0, False, False
    for i, ch in enumerate(cleaned[start:], start):
        if escape:
            escape = False
            continue
        if ch == "\\" and in_str:
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == open_c:
            depth += 1
        elif ch == close_c:
            depth -= 1
            if depth == 0:
                return json.loads(cleaned[start : i + 1])
    raise ValueError("Unbalanced JSON in LLM response")


def normalize_enhancement_payload(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "improved_expected_result": str(data.get("improved_expected_result", "")).strip(),
        "intent": str(data.get("intent", "")).strip(),
        "requirement": str(data.get("requirement", "")).strip(),
        "reasoning": str(data.get("reasoning", "")).strip(),
    }


def normalize_scoring_payload(
    data: dict[str, Any],
    pass_threshold: float = 80,
    partial_threshold: float = 50,
) -> dict[str, Any]:
    accuracy   = _clamp_score(data.get("accuracy", 0))
    intent     = _clamp_score(data.get("intent", 0))
    efficiency = _clamp_score(data.get("efficiency", 0))
    consolidated = data.get("consolidated_percentage")
    if consolidated is None:
        consolidated = consolidated_percentage(accuracy, intent, efficiency)
    else:
        consolidated = round(float(consolidated), 2)

    status = data.get("status")
    if status not in ("Pass", "Partial", "Fail"):
        status = status_from_consolidated(consolidated, pass_threshold, partial_threshold)

    return {
        "accuracy": accuracy,
        "intent": intent,
        "efficiency": efficiency,
        "consolidated_percentage": consolidated,
        "status": status,
        "accuracy_justification": str(data.get("accuracy_justification", "")).strip(),
        "intent_justification": str(data.get("intent_justification", "")).strip(),
        "efficiency_justification": str(data.get("efficiency_justification", "")).strip(),
    }


def _clamp_score(v: Any) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        n = 0.0
    return max(0.0, min(100.0, n))


def build_report_row(
    test_scenario: str,
    expected_result: str,
    newly_generated_expected: str,
    actual_result: str,
    scores: dict[str, Any],
) -> dict[str, Any]:
    """Single report row — field order matches spec."""
    return {
        "test_scenario": test_scenario,
        "expected_result": expected_result,
        "newly_generated_expected_result": newly_generated_expected,
        "actual_result": actual_result,
        "accuracy": scores["accuracy"],
        "intent": scores["intent"],
        "efficiency": scores["efficiency"],
        "status": scores["status"],
        "consolidated_percentage": scores["consolidated_percentage"],
        "accuracy_justification": scores.get("accuracy_justification", ""),
        "intent_justification": scores.get("intent_justification", ""),
        "efficiency_justification": scores.get("efficiency_justification", ""),
    }


def summarize_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(rows)
    if total == 0:
        return {
            "total": 0,
            "pass": 0,
            "partial": 0,
            "fail": 0,
            "avg_accuracy": 0,
            "avg_intent": 0,
            "avg_efficiency": 0,
            "avg_consolidated_percentage": 0,
        }
    pass_n    = sum(1 for r in rows if r.get("status") == "Pass")
    partial_n = sum(1 for r in rows if r.get("status") == "Partial")
    fail_n    = sum(1 for r in rows if r.get("status") == "Fail")
    return {
        "total": total,
        "pass": pass_n,
        "partial": partial_n,
        "fail": fail_n,
        "avg_accuracy": round(sum(r.get("accuracy", 0) for r in rows) / total, 2),
        "avg_intent": round(sum(r.get("intent", 0) for r in rows) / total, 2),
        "avg_efficiency": round(sum(r.get("efficiency", 0) for r in rows) / total, 2),
        "avg_consolidated_percentage": round(
            sum(r.get("consolidated_percentage", 0) for r in rows) / total, 2
        ),
    }
