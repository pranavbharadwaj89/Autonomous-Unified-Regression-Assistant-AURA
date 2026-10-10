"""
Allure-style and downloadable reports for Judge LLM evaluation.
"""

from __future__ import annotations

import html
import json
from datetime import datetime, timezone
from typing import Any


REPORT_COLUMNS = [
    ("test_scenario", "Test Scenario"),
    ("expected_result", "Expected Result"),
    ("newly_generated_expected_result", "Newly Generated Expected Result"),
    ("actual_result", "Actual Result"),
    ("accuracy", "Accuracy"),
    ("intent", "Intent"),
    ("efficiency", "Efficiency"),
    ("status", "Status"),
    ("consolidated_percentage", "Consolidated Percentage"),
]


def build_allure_payload(
    rows: list[dict[str, Any]],
    summary: dict[str, Any],
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Allure-compatible structure for frontend HTML generator."""
    tests = []
    for i, row in enumerate(rows):
        status_map = {"Pass": "passed", "Partial": "broken", "Fail": "failed"}
        allure_status = status_map.get(row.get("status"), "failed")
        attachments = [
            {"name": "Accuracy Justification", "type": "text/plain", "source": row.get("accuracy_justification", "")},
            {"name": "Intent Justification", "type": "text/plain", "source": row.get("intent_justification", "")},
            {"name": "Efficiency Justification", "type": "text/plain", "source": row.get("efficiency_justification", "")},
        ]
        if row.get("enhancement", {}).get("reasoning"):
            attachments.append({
                "name": "Enhancement Reasoning",
                "type": "text/plain",
                "source": row["enhancement"]["reasoning"],
            })
        tests.append({
            "uuid": f"judge-{i}-{row.get('tc_id', i)}",
            "name": row.get("test_scenario", f"Test {i + 1}"),
            "status": allure_status,
            "labels": [
                {"name": "suite", "value": "Judge LLM Evaluation"},
                {"name": "result", "value": row.get("status", "Fail")},
            ],
            "parameters": [
                {"name": "Accuracy", "value": str(row.get("accuracy", 0))},
                {"name": "Intent", "value": str(row.get("intent", 0))},
                {"name": "Efficiency", "value": str(row.get("efficiency", 0))},
                {"name": "Consolidated %", "value": str(row.get("consolidated_percentage", 0))},
            ],
            "attachments": attachments,
            "steps": [
                {"name": "Original Expected", "status": "passed", "attachments": [
                    {"name": "expected", "source": row.get("expected_result", "")}
                ]},
                {"name": "Judge Enhanced Expected", "status": "passed", "attachments": [
                    {"name": "improved", "source": row.get("newly_generated_expected_result", "")}
                ]},
                {"name": "Executor Actual", "status": "passed", "attachments": [
                    {"name": "actual", "source": row.get("actual_result", "")}
                ]},
            ],
        })

    return {
        "reportName": "Judge LLM Evaluation",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "meta": meta or {},
        "summary": {
            "total": summary.get("total", 0),
            "pass": summary.get("pass", 0),
            "partial": summary.get("partial", 0),
            "fail": summary.get("fail", 0),
            "avg_consolidated_percentage": summary.get("avg_consolidated_percentage", 0),
            "avg_accuracy": summary.get("avg_accuracy", 0),
            "avg_intent": summary.get("avg_intent", 0),
            "avg_efficiency": summary.get("avg_efficiency", 0),
        },
        "tests": tests,
        "rows": rows,
    }


def generate_html_report(
    rows: list[dict[str, Any]],
    summary: dict[str, Any],
    meta: dict[str, Any] | None = None,
) -> str:
    """Standalone HTML table + summary."""
    meta = meta or {}
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    def esc(v: Any) -> str:
        return html.escape(str(v if v is not None else ""))

    header_cells = "".join(f"<th>{esc(label)}</th>" for _, label in REPORT_COLUMNS)
    body_rows = []
    for row in rows:
        cells = []
        for key, _ in REPORT_COLUMNS:
            val = row.get(key, "")
            if key in ("accuracy", "intent", "efficiency", "consolidated_percentage"):
                cells.append(f"<td class='num'>{esc(val)}</td>")
            elif key == "status":
                cls = {"Pass": "pass", "Partial": "partial", "Fail": "fail"}.get(str(val), "")
                cells.append(f"<td class='status {cls}'>{esc(val)}</td>")
            else:
                cells.append(f"<td class='text'>{esc(val)}</td>")
        body_rows.append(f"<tr>{''.join(cells)}</tr>")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Judge LLM Evaluation Report</title>
<style>
  body {{ font-family: system-ui, sans-serif; margin: 24px; color: #1a1a1a; }}
  h1 {{ font-size: 1.4rem; }}
  .meta {{ color: #666; font-size: 0.9rem; margin-bottom: 16px; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 0.85rem; }}
  th, td {{ border: 1px solid #ddd; padding: 8px; vertical-align: top; }}
  th {{ background: #f4f4f4; text-align: left; }}
  td.text {{ max-width: 280px; white-space: pre-wrap; word-break: break-word; }}
  td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  td.status.pass {{ color: #0a7; font-weight: 600; }}
  td.status.partial {{ color: #c80; font-weight: 600; }}
  td.status.fail {{ color: #c22; font-weight: 600; }}
  .summary {{ margin-top: 24px; padding: 16px; background: #f9f9f9; border-radius: 8px; }}
  .summary dl {{ display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; }}
</style>
</head>
<body>
<h1>Judge LLM Evaluation Report</h1>
<p class="meta">Generated {esc(ts)} · Executor: {esc(meta.get('executor_model', '—'))} · Judge: {esc(meta.get('judge_model', '—'))}</p>
<table>
<thead><tr>{header_cells}</tr></thead>
<tbody>
{''.join(body_rows)}
</tbody>
</table>
<section class="summary">
<h2>Summary</h2>
<dl>
<dt>Total test cases</dt><dd>{summary.get('total', 0)}</dd>
<dt>Pass / Partial / Fail</dt><dd>{summary.get('pass', 0)} / {summary.get('partial', 0)} / {summary.get('fail', 0)}</dd>
<dt>Avg Accuracy</dt><dd>{summary.get('avg_accuracy', 0)}</dd>
<dt>Avg Intent</dt><dd>{summary.get('avg_intent', 0)}</dd>
<dt>Avg Efficiency</dt><dd>{summary.get('avg_efficiency', 0)}</dd>
<dt>Avg Consolidated %</dt><dd>{summary.get('avg_consolidated_percentage', 0)}</dd>
</dl>
</section>
</body>
</html>"""


def generate_csv_report(rows: list[dict[str, Any]]) -> str:
    import csv
    import io

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([label for _, label in REPORT_COLUMNS])
    for row in rows:
        writer.writerow([row.get(key, "") for key, _ in REPORT_COLUMNS])
    return buf.getvalue()


def format_report(
    rows: list[dict[str, Any]],
    summary: dict[str, Any],
    meta: dict[str, Any] | None,
    report_format: str,
) -> dict[str, Any]:
    fmt = (report_format or "html").lower()
    out: dict[str, Any] = {"format": fmt}
    if fmt == "html":
        out["content"] = generate_html_report(rows, summary, meta)
        out["mime"] = "text/html"
        out["filename"] = "judge-evaluation-report.html"
    elif fmt == "csv":
        out["content"] = generate_csv_report(rows)
        out["mime"] = "text/csv"
        out["filename"] = "judge-evaluation-report.csv"
    elif fmt == "json":
        out["content"] = json.dumps({"rows": rows, "summary": summary, "meta": meta}, indent=2)
        out["mime"] = "application/json"
        out["filename"] = "judge-evaluation-report.json"
    else:
        # DOCX/PDF not required server-side — fall back to HTML
        out["content"] = generate_html_report(rows, summary, meta)
        out["mime"] = "text/html"
        out["filename"] = "judge-evaluation-report.html"
        out["note"] = f"Format '{fmt}' uses HTML export; open in browser and Print to PDF if needed."
    return out
