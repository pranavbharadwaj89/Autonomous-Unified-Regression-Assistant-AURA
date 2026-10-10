"""
Judge LLM service — Prompt 1 (enhance expected) and Prompt 2 (score actual).
Uses isolated .env.judge config only.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from judge_scoring import (
    extract_json_object,
    normalize_enhancement_payload,
    normalize_scoring_payload,
)

logger = logging.getLogger(__name__)

PROMPT_1_SYSTEM = """You are a QA requirements analyst. Your task is to improve regression test expected results using the original expected result AND a requirements document excerpt as your source of truth.

Given a test scenario, the original expected result from a regression sheet, and a relevant excerpt from the requirements document, analyze across four dimensions:
1. Intent — what the test is trying to validate
2. Accuracy — whether the original expected result is technically correct and precise
3. Efficiency — whether it is concise and unambiguous
4. Requirement — the underlying requirement from the requirements document

Generate a precise, complete, requirement-aligned expected result.

Return ONLY valid JSON with this exact structure (no markdown, no preamble):
{
  "improved_expected_result": "...",
  "intent": "...",
  "requirement": "...",
  "reasoning": "..."
}"""

PROMPT_2_SYSTEM = """You are a senior QA judge evaluating voice-assistant regression test outcomes.

Given the newly generated expected result (source of truth) and the actual result from test execution, score the actual result on a 0–100 scale for each dimension:

- Accuracy (0–100): factual and technical correctness vs expected
- Intent (0–100): how well the actual result fulfills the test intent
- Efficiency (0–100): conciseness, clarity, and lack of ambiguity

Compute consolidated_percentage as (accuracy + intent + efficiency) / 3 rounded to 2 decimal places.
Assign status: Pass if consolidated >= 80, Partial if 50–79, Fail if < 50.

Return ONLY valid JSON with this exact structure (no markdown):
{
  "accuracy": 0,
  "intent": 0,
  "efficiency": 0,
  "consolidated_percentage": 0,
  "status": "Pass|Partial|Fail",
  "accuracy_justification": "...",
  "intent_justification": "...",
  "efficiency_justification": "..."
}"""


def _chat_completion(
    judge_cfg: dict[str, str],
    system: str,
    user: str,
    timeout: float = 90,
) -> str:
    api_key = judge_cfg.get("LLM_API_KEY", "")
    base_url = (judge_cfg.get("LLM_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    model = judge_cfg.get("LLM_MODEL_NAME", "gpt-5.4-mini")

    if not api_key:
        raise ValueError("Judge LLM API key missing in .env.judge")

    url = f"{base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    body = {
        "model": model,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }

    with httpx.Client(timeout=timeout) as client:
        resp = client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


def enhance_expected_result(
    test_scenario: str,
    expected_result: str,
    judge_cfg: dict[str, str],
    timeout: float = 90,
    requirement_context: str = "",
) -> dict[str, Any]:
    req_section = (
        f"\nRequirement Document excerpt:\n{requirement_context}\n"
        if requirement_context.strip()
        else ""
    )
    user = (
        f"Test Scenario:\n{test_scenario}\n\n"
        f"Original Expected Result:\n{expected_result}\n"
        f"{req_section}\n"
        "Analyze intent, accuracy, efficiency, and requirement. "
        "Generate an improved expected result and return JSON only."
    )
    try:
        raw = _chat_completion(judge_cfg, PROMPT_1_SYSTEM, user, timeout=timeout)
        parsed = extract_json_object(raw)
        return normalize_enhancement_payload(parsed)
    except Exception as e:
        logger.error("Prompt 1 failed for scenario %r: %s", test_scenario[:80], e)
        return {
            "improved_expected_result": expected_result,
            "intent": "",
            "requirement": "",
            "reasoning": f"Enhancement failed: {e}",
            "error": str(e),
        }


def score_actual_result(
    test_scenario: str,
    improved_expected: str,
    actual_result: str,
    judge_cfg: dict[str, str],
    pass_threshold: float = 80,
    partial_threshold: float = 50,
    timeout: float = 90,
) -> dict[str, Any]:
    user = (
        f"Test Scenario:\n{test_scenario}\n\n"
        f"Newly Generated Expected Result (source of truth):\n{improved_expected}\n\n"
        f"Actual Result:\n{actual_result}\n\n"
        "Score the actual result and return JSON."
    )
    try:
        raw = _chat_completion(judge_cfg, PROMPT_2_SYSTEM, user, timeout=timeout)
        parsed = extract_json_object(raw)
        return normalize_scoring_payload(parsed, pass_threshold, partial_threshold)
    except Exception as e:
        logger.error("Prompt 2 failed for scenario %r: %s", test_scenario[:80], e)
        return {
            "accuracy": 0,
            "intent": 0,
            "efficiency": 0,
            "consolidated_percentage": 0.0,
            "status": "Fail",
            "accuracy_justification": f"Scoring failed: {e}",
            "intent_justification": "",
            "efficiency_justification": "",
            "error": str(e),
        }
