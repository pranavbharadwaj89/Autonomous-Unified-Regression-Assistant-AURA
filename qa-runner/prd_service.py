"""
prd_service.py
─────────────────────────────────────────────────────────────────────────────
PRD → Requirements → Test Cases pipeline via OpenAI.

Env vars required:
    OPENAI_API_KEY   — your OpenAI key
    OPENAI_BASE_URL  — optional override (Azure / local proxy), default: https://api.openai.com/v1
    PRD_MODEL        — model to use, default: gpt-4o
    PRD_MAX_TOKENS   — max tokens per completion, default: 4096
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

import httpx

# ── Config ────────────────────────────────────────────────────────────────────

OPENAI_BASE = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_KEY  = os.getenv("OPENAI_API_KEY", "")
MODEL       = os.getenv("PRD_MODEL", "gpt-4o")
MAX_TOKENS  = int(os.getenv("PRD_MAX_TOKENS", "4096"))

# ── Low-level OpenAI call ─────────────────────────────────────────────────────

async def _chat(messages: list[dict], max_tokens: int = MAX_TOKENS, model: str = MODEL) -> str:
    """Fire a single chat completion, return the message content string."""
    if not OPENAI_KEY:
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Add it to qa-runner/.env to enable PRD analysis."
        )
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{OPENAI_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENAI_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": 0.3,
            },
        )
        resp.raise_for_status()
        data = resp.json()
    return data["choices"][0]["message"]["content"]


def _extract_json(text: str) -> Any:
    """Extract the first JSON array or object from an LLM response."""
    # Strip markdown code fences
    text = re.sub(r"```(?:json)?\s*", "", text).strip().rstrip("`").strip()
    # Find first [ or {
    start = next((i for i, c in enumerate(text) if c in ("[", "{")), None)
    if start is None:
        raise ValueError(f"No JSON found in response: {text[:200]}")
    # Find the balanced end
    depth, in_str, escape = 0, False, False
    open_c  = text[start]
    close_c = "]" if open_c == "[" else "}"
    for i, ch in enumerate(text[start:], start):
        if escape:
            escape = False; continue
        if ch == "\\" and in_str:
            escape = True; continue
        if ch == '"' and not escape:
            in_str = not in_str; continue
        if in_str:
            continue
        if ch == open_c:
            depth += 1
        elif ch == close_c:
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i + 1])
    raise ValueError("Unbalanced JSON in response")


# ── Step 1: Extract requirements from PRD text ────────────────────────────────

REQUIREMENTS_SYSTEM = """\
You are a senior QA requirements analyst for an in-vehicle AI voice assistant (IVI system).
Given a PRD or feature specification document, extract ALL testable functional requirements.

Rules:
- Extract one requirement per distinct feature, user story, or acceptance criterion.
- If the document mentions a feature without explicit detail, infer reasonable requirements.
- Group requirements by functional area (Navigation, Weather, Music, Reminders, Calls, etc.).
- Assign priorities: P1 (must-have / core path), P2 (important), P3 (nice-to-have / edge case).
- Return ONLY a valid JSON array — no prose, no markdown, no explanation.

Each requirement object:
{
  "id":          "REQ-001",
  "category":    "Navigation|Weather|Music|Reminders|Calls|Assistant|TimezoneTime|VehicleControl|Other",
  "title":       "Short title (≤10 words)",
  "description": "Detailed description of what the system must do",
  "priority":    "P1|P2|P3",
  "acceptance":  "How you would verify this is working correctly"
}
"""

async def extract_requirements(prd_text: str) -> list[dict]:
    """
    Given raw PRD text, return a structured list of testable requirements.
    """
    prd_snippet = prd_text[:12_000]  # guard against token overflow
    messages = [
        {"role": "system", "content": REQUIREMENTS_SYSTEM},
        {"role": "user",   "content": f"Extract all testable requirements from this PRD:\n\n{prd_snippet}"},
    ]
    raw = await _chat(messages, max_tokens=MAX_TOKENS)
    reqs = _extract_json(raw)
    # Normalise and ensure required fields
    normalised = []
    for i, req in enumerate(reqs, 1):
        normalised.append({
            "id":          req.get("id") or f"REQ-{i:03d}",
            "category":    req.get("category", "Other"),
            "title":       req.get("title", ""),
            "description": req.get("description", ""),
            "priority":    req.get("priority", "P2"),
            "acceptance":  req.get("acceptance", ""),
        })
    return normalised


# ── Step 2: Generate test cases from requirements ─────────────────────────────

TC_SYSTEM = """\
You are a senior QA engineer writing test cases for a voice AI assistant in an IVI
(In-Vehicle Infotainment) system called CARA.

━━━ MANDATORY COUNTS — you MUST follow these exactly ━━━
• P1 requirement → generate EXACTLY 3 test cases:
    TC #1 — testType: "Positive"   (happy path, valid input)
    TC #2 — testType: "Negative"   (invalid/missing/wrong input, error handling)
    TC #3 — testType: "Boundary"   (edge case: empty input, ambiguous phrasing, multilingual, etc.)
• P2 requirement → generate EXACTLY 2 test cases:
    TC #1 — testType: "Positive"
    TC #2 — testType: "Negative"
• P3 requirement → generate EXACTLY 1 test case:
    TC #1 — testType: "Positive"

If you generate fewer TCs than required, the output will be REJECTED.

━━━ VOICE INPUT RULES ━━━
- Write inputs as natural spoken language exactly as a driver says them.
- Use colloquial phrasing: "Hey, what's the weather like in Mumbai?" not "weather Mumbai".
- Negative TCs must have clearly invalid/impossible inputs, e.g. "Navigate to blah blah xyz123".
- Boundary TCs must probe unusual cases: very short ("Navigate"), very long, ambiguous location names, etc.

━━━ EXPECTED INTENT — use ONLY these values ━━━
navigation, get_current_weather, get_future_weather, get_past_weather, play_music,
time_based_reminder, cancel_reminder, reschedule, get_locale_time, get_time_in_location,
track_flight_status, get_assistant_info, place_call, vehicle_status, vehicle_command,
general_conversation, get_live_data

━━━ ID FORMAT ━━━
TC_<MODULE>_<NNN> where MODULE is the 3-5 letter abbreviation:
  NAV=Navigation, WEATH=Weather, MUS=Music, REM=Reminders, TIM=Time,
  AI=Assistant, VEH=Vehicle Control, CALL=Calls, GEN=General

━━━ OUTPUT FORMAT ━━━
Return ONLY a valid JSON array — zero prose, zero markdown, zero explanation.
Each element:
{
  "id":                "TC_NAV_001",
  "module":            "Navigation",
  "flow":              "Single-Turn",
  "testCategory":      "Functional",
  "testType":          "Positive",
  "input":             "Hey, take me to Indiranagar Bangalore.",
  "expectedIntent":    "navigation",
  "expectedResponse":  "Starting navigation to Indiranagar, Bangalore.",
  "priority":          "P1",
  "sessionId":         "",
  "turnNo":            1,
  "sourceRequirement": "REQ-001"
}

━━━ EXAMPLE — for a P1 requirement REQ-003 about weather queries ━━━
[
  {
    "id": "TC_WEATH_001", "module": "Weather", "flow": "Single-Turn",
    "testCategory": "Functional", "testType": "Positive",
    "input": "What's the weather like in Chennai right now?",
    "expectedIntent": "get_current_weather",
    "expectedResponse": "The current weather in Chennai is clear skies with 32 degrees.",
    "priority": "P1", "sessionId": "", "turnNo": 1, "sourceRequirement": "REQ-003"
  },
  {
    "id": "TC_WEATH_002", "module": "Weather", "flow": "Single-Turn",
    "testCategory": "Functional", "testType": "Negative",
    "input": "What is the weather on Mars?",
    "expectedIntent": "get_current_weather",
    "expectedResponse": "I'm unable to retrieve weather information for that location.",
    "priority": "P1", "sessionId": "", "turnNo": 1, "sourceRequirement": "REQ-003"
  },
  {
    "id": "TC_WEATH_003", "module": "Weather", "flow": "Single-Turn",
    "testCategory": "Edge Case", "testType": "Boundary",
    "input": "Weather?",
    "expectedIntent": "get_current_weather",
    "expectedResponse": "Please specify a city or location for the weather update.",
    "priority": "P1", "sessionId": "", "turnNo": 1, "sourceRequirement": "REQ-003"
  }
]
"""

async def generate_test_cases(requirements: list[dict]) -> list[dict]:
    """
    Given a list of requirements, generate a comprehensive test case suite.
    """
    req_json = json.dumps(requirements, indent=2)
    # Chunk if too many requirements
    if len(requirements) > 30:
        chunks = [requirements[i:i+20] for i in range(0, len(requirements), 20)]
    else:
        chunks = [requirements]

    all_tcs: list[dict] = []
    tc_counter: dict[str, int] = {}

    for chunk in chunks:
        # Count expected TCs so we can include reminder in prompt
        expected = sum(3 if r.get("priority") == "P1" else 2 if r.get("priority") == "P2" else 1 for r in chunk)
        messages = [
            {"role": "system", "content": TC_SYSTEM},
            {"role": "user",   "content": (
                f"Generate test cases for the following {len(chunk)} requirements.\n"
                f"REMINDER: P1→3 TCs, P2→2 TCs, P3→1 TC. "
                f"You must return a JSON array of EXACTLY {expected} test case objects.\n\n"
                f"{json.dumps(chunk, indent=2)}"
            )},
        ]
        raw  = await _chat(messages, max_tokens=MAX_TOKENS)
        tcs  = _extract_json(raw)
        all_tcs.extend(tcs)

    # Normalise + ensure unique IDs
    normalised = []
    seen_ids: set[str] = set()
    for tc in all_tcs:
        tc_id = tc.get("id", "")
        if tc_id in seen_ids or not tc_id:
            # Re-number
            mod   = _module_abbrev(tc.get("module", "GEN"))
            n     = tc_counter.get(mod, 0) + 1
            tc_counter[mod] = n
            tc_id = f"TC_{mod}_{n:03d}"
        seen_ids.add(tc_id)
        normalised.append({
            "id":                tc_id,
            "module":            tc.get("module", "General"),
            "flow":              tc.get("flow", "Single-Turn"),
            "testCategory":      tc.get("testCategory", "Functional"),
            "testType":          tc.get("testType", "Positive"),
            "input":             tc.get("input", ""),
            "expectedIntent":    tc.get("expectedIntent", "general_conversation"),
            "expectedResponse":  tc.get("expectedResponse", ""),
            "priority":          tc.get("priority", "P2"),
            "sessionId":         tc.get("sessionId", ""),
            "turnNo":            int(tc.get("turnNo") or 1),
            "sourceRequirement": tc.get("sourceRequirement", ""),
        })

    return normalised


def _module_abbrev(module_name: str) -> str:
    abbrevs = {
        "navigation":      "NAV",
        "weather":         "WEATH",
        "music":           "MUS",
        "reminders":       "REM",
        "time":            "TIM",
        "assistant":       "AI",
        "vehicle control": "VEH",
        "calls":           "CALL",
        "general":         "GEN",
    }
    return abbrevs.get(module_name.lower(), module_name[:4].upper())


# ── Combined one-shot pipeline ────────────────────────────────────────────────

async def prd_to_test_cases(prd_text: str) -> dict:
    """
    Full pipeline: PRD text → requirements → test cases.
    Returns { requirements: [...], test_cases: [...], stats: {...} }.
    """
    t0 = time.time()
    requirements = await extract_requirements(prd_text)
    reqs_time    = round(time.time() - t0, 1)

    t1 = time.time()
    test_cases   = await generate_test_cases(requirements)
    tcs_time     = round(time.time() - t1, 1)

    p1 = sum(1 for tc in test_cases if tc["priority"] == "P1")
    p2 = sum(1 for tc in test_cases if tc["priority"] == "P2")
    p3 = sum(1 for tc in test_cases if tc["priority"] == "P3")
    by_module = {}
    for tc in test_cases:
        by_module[tc["module"]] = by_module.get(tc["module"], 0) + 1

    return {
        "requirements": requirements,
        "test_cases":   test_cases,
        "stats": {
            "requirement_count":  len(requirements),
            "test_case_count":    len(test_cases),
            "by_priority":        {"P1": p1, "P2": p2, "P3": p3},
            "by_module":          by_module,
            "requirements_time_s": reqs_time,
            "generation_time_s":   tcs_time,
            "total_time_s":        round(time.time() - t0, 1),
        },
    }
