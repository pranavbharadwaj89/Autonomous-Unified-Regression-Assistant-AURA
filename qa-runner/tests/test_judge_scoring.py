"""Unit tests for Judge LLM scoring utilities."""

import json
import unittest

from judge_scoring import (
    build_report_row,
    consolidated_percentage,
    extract_json_object,
    normalize_scoring_payload,
    status_from_consolidated,
    summarize_rows,
)


class TestConsolidatedPercentage(unittest.TestCase):
    def test_average_rounded(self):
        self.assertEqual(consolidated_percentage(90, 80, 70), 80.0)

    def test_equal_scores(self):
        self.assertEqual(consolidated_percentage(100, 100, 100), 100.0)

    def test_zero_scores(self):
        self.assertEqual(consolidated_percentage(0, 0, 0), 0.0)


class TestStatusThresholds(unittest.TestCase):
    def test_pass_at_80(self):
        self.assertEqual(status_from_consolidated(80), "Pass")

    def test_pass_above_80(self):
        self.assertEqual(status_from_consolidated(95.5), "Pass")

    def test_partial_range(self):
        self.assertEqual(status_from_consolidated(79.99), "Partial")
        self.assertEqual(status_from_consolidated(50), "Partial")

    def test_fail_below_50(self):
        self.assertEqual(status_from_consolidated(49.99), "Fail")

    def test_custom_thresholds(self):
        self.assertEqual(status_from_consolidated(70, pass_threshold=75, partial_threshold=40), "Partial")
        self.assertEqual(status_from_consolidated(76, pass_threshold=75, partial_threshold=40), "Pass")


class TestJsonParsing(unittest.TestCase):
    def test_plain_json(self):
        raw = '{"accuracy": 85, "intent": 90, "efficiency": 80}'
        data = extract_json_object(raw)
        self.assertEqual(data["accuracy"], 85)

    def test_markdown_fence(self):
        raw = '```json\n{"improved_expected_result": "hello"}\n```'
        data = extract_json_object(raw)
        self.assertEqual(data["improved_expected_result"], "hello")

    def test_empty_raises(self):
        with self.assertRaises(ValueError):
            extract_json_object("")


class TestNormalizeScoring(unittest.TestCase):
    def test_computes_consolidated_when_missing(self):
        out = normalize_scoring_payload({"accuracy": 60, "intent": 90, "efficiency": 30})
        self.assertEqual(out["consolidated_percentage"], 60.0)
        self.assertEqual(out["status"], "Partial")

    def test_clamps_scores(self):
        out = normalize_scoring_payload({"accuracy": 150, "intent": -5, "efficiency": 50})
        self.assertEqual(out["accuracy"], 100.0)
        self.assertEqual(out["intent"], 0.0)

    def test_respects_provided_status(self):
        out = normalize_scoring_payload(
            {"accuracy": 100, "intent": 100, "efficiency": 100, "status": "Pass"}
        )
        self.assertEqual(out["status"], "Pass")


class TestReportRow(unittest.TestCase):
    def test_field_order_keys(self):
        row = build_report_row(
            "scenario",
            "orig expected",
            "new expected",
            "actual",
            normalize_scoring_payload({"accuracy": 80, "intent": 80, "efficiency": 80}),
        )
        keys = list(row.keys())[:9]
        self.assertEqual(
            keys,
            [
                "test_scenario",
                "expected_result",
                "newly_generated_expected_result",
                "actual_result",
                "accuracy",
                "intent",
                "efficiency",
                "status",
                "consolidated_percentage",
            ],
        )


class TestSummarizeRows(unittest.TestCase):
    def test_empty(self):
        s = summarize_rows([])
        self.assertEqual(s["total"], 0)

    def test_counts_and_averages(self):
        rows = [
            {"status": "Pass", "accuracy": 90, "intent": 90, "efficiency": 90, "consolidated_percentage": 90},
            {"status": "Fail", "accuracy": 30, "intent": 30, "efficiency": 30, "consolidated_percentage": 30},
        ]
        s = summarize_rows(rows)
        self.assertEqual(s["pass"], 1)
        self.assertEqual(s["fail"], 1)
        self.assertEqual(s["avg_accuracy"], 60.0)


if __name__ == "__main__":
    unittest.main()
