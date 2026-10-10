/**
 * Judge LLM Evaluation Panel
 *
 * Standalone pipeline — does NOT auto-chain with regression.
 * Branch A: Executor (5.4 Nano) → actual results via CARA /process-text
 * Branch B: Judge (4o Mini) → enhanced expected + scoring
 * Report returned to UI (Allure-style + downloadable HTML/CSV).
 */

import { useState, useCallback, useEffect } from "react";
import { PIPELINE_OPT_IN } from "../config/pipelines.js";
import { downloadJudgeAllureReport } from "../utils/generateAllureReport.js";

const QA_RUNNER_BASE = "http://localhost:3001";

const COLS = [
  { key: "test_scenario", label: "Test Scenario" },
  { key: "expected_result", label: "Expected Result" },
  { key: "newly_generated_expected_result", label: "Newly Generated Expected Result" },
  { key: "actual_result", label: "Actual Result" },
  { key: "accuracy", label: "Accuracy" },
  { key: "intent", label: "Intent" },
  { key: "efficiency", label: "Efficiency" },
  { key: "status", label: "Status" },
  { key: "consolidated_percentage", label: "Consolidated %" },
];

function statusClass(s) {
  if (s === "Pass") return "badge-pass";
  if (s === "Partial") return "badge-partial";
  return "badge-fail";
}

export default function JudgeEvaluationPanel({ testCases = [], config = {}, results = {} }) {
  const [judgeConfig, setJudgeConfig] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [withExecutor, setWithExecutor] = useState(true);
  const [selectedIds, setSelectedIds] = useState(null);
  const [reportFormat, setReportFormat] = useState("html");

  useEffect(() => {
    fetch(`${QA_RUNNER_BASE}/judge/config`)
      .then(r => r.ok ? r.json() : null)
      .then(setJudgeConfig)
      .catch(() => setJudgeConfig(null));
  }, []);

  const buildPayloadCases = useCallback(() => {
    const ids = selectedIds?.length ? new Set(selectedIds) : null;
    const list = ids ? testCases.filter(tc => ids.has(tc.id)) : testCases;
    return list.map(tc => {
      const r = results[tc.id];
      const actualFromRegression = r
        ? [
            r.detectedIntent ? `Intent: ${r.detectedIntent}` : "",
            r.assistantResponse ? `Response: ${r.assistantResponse}` : "",
          ].filter(Boolean).join("\n")
        : "";
      return {
        id: tc.id,
        input: tc.input,
        expectedIntent: tc.expectedIntent,
        expectedResponse: tc.expectedResponse,
        module: tc.module,
        sessionId: tc.sessionId,
        flow: tc.flow,
        language: config.language,
        timezone: config.timezone,
        latitude: config.latitude,
        longitude: config.longitude,
        pipeline: config.pipeline,
        vehicleBackend: config.vehicleBackend,
        vehicleVin: config.vehicleVin,
        regressionVehicleToken: config.regressionVehicleToken,
        actualResult: withExecutor ? undefined : actualFromRegression,
      };
    });
  }, [testCases, selectedIds, results, config, withExecutor]);

  const runEvaluation = useCallback(async () => {
    const cases = buildPayloadCases();
    if (!cases.length) {
      setError("No test cases to evaluate.");
      return;
    }
    if (!window.confirm(
      `Run Judge LLM evaluation on ${cases.length} test case(s)?\n\n` +
      (withExecutor
        ? "Executor will call CARA /process-text (LLM 1). Judge runs in parallel (LLM 2)."
        : "Using existing regression actual results only (no executor calls).")
    )) return;

    setRunning(true);
    setError(null);
    setProgress({ done: 0, total: cases.length });
    setReport(null);

    try {
      const resp = await fetch(`${QA_RUNNER_BASE}/judge/run-evaluation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCases: cases,
          caraBaseUrl: config.backendUrl,
          brand: "stellantis",
          deviceId: config.deviceId,
          withExecutor,
          reportFormat,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      setReport(data);
      setProgress({ done: cases.length, total: cases.length });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setRunning(false);
    }
  }, [buildPayloadCases, config, withExecutor, reportFormat]);

  const downloadReport = useCallback((fmt) => {
    if (!report) return;
    if (fmt === "allure" && report.allure) {
      downloadJudgeAllureReport({
        allure: report.allure,
        summary: report.summary,
        meta: report.meta,
        projectName: "Judge LLM Evaluation",
      });
      return;
    }
    const dl = report.download;
    if (dl?.content) {
      const blob = new Blob([dl.content], { type: dl.mime || "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = dl.filename || `judge-report.${fmt}`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }, [report]);

  const summary = report?.summary;
  const rows = report?.rows || [];

  return (
    <div className="stack fade-in" style={{ gap: 20 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Judge LLM Evaluation</div>
            <div className="card-sub">
              Parallel executor + judge pipeline — standalone ({PIPELINE_OPT_IN.PRISM_WITH_JUDGE} pattern).
              Report returns to UI; regression flow is not modified.
            </div>
          </div>
        </div>

        <div className="stack" style={{ gap: 12 }}>
          {judgeConfig && (
            <div style={{ fontSize: 12, color: "var(--text3)", fontFamily: "var(--mono)" }}>
              Executor: {judgeConfig.executor?.model || "—"} · Judge: {judgeConfig.judge?.model || "—"} ·
              Pass ≥ {judgeConfig.thresholds?.pass ?? 80} · Partial ≥ {judgeConfig.thresholds?.partial ?? 50}
            </div>
          )}

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={withExecutor}
              onChange={e => setWithExecutor(e.target.checked)}
            />
            Run executor (LLM 1) via CARA — uncheck to score existing regression results only
          </label>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <select
              className="form-select"
              style={{ width: 140 }}
              value={reportFormat}
              onChange={e => setReportFormat(e.target.value)}
            >
              <option value="html">HTML</option>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
            <button
              className="btn btn-primary"
              disabled={running || !testCases.length}
              onClick={runEvaluation}
            >
              {running ? "Evaluating…" : "▶ Run Judge Evaluation"}
            </button>
            {report && (
              <>
                <button className="btn btn-secondary" onClick={() => downloadReport("allure")}>
                  Download Allure HTML
                </button>
                <button className="btn btn-secondary" onClick={() => downloadReport(reportFormat)}>
                  Download {reportFormat.toUpperCase()}
                </button>
              </>
            )}
          </div>

          <div style={{ fontSize: 12, color: "var(--text3)" }}>
            {testCases.length} test case(s) in project
            {progress && ` · ${progress.done}/${progress.total} processed`}
          </div>

          {error && (
            <div style={{ color: "var(--fail)", fontSize: 13 }}>{error}</div>
          )}
        </div>
      </div>

      {summary && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Summary</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
            {[
              ["Total", summary.total],
              ["Pass", summary.pass],
              ["Partial", summary.partial],
              ["Fail", summary.fail],
              ["Avg Accuracy", summary.avg_accuracy],
              ["Avg Intent", summary.avg_intent],
              ["Avg Efficiency", summary.avg_efficiency],
              ["Avg Consolidated %", summary.avg_consolidated_percentage],
            ].map(([label, val]) => (
              <div key={label} style={{ background: "var(--surface2)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase" }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--mono)" }}>{val}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Evaluation Results</div>
          </div>
          <div className="table-wrap" style={{ overflowX: "auto" }}>
            <table className="tc-table">
              <thead>
                <tr>
                  {COLS.map(c => <th key={c.key}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.tc_id || i}>
                    {COLS.map(c => (
                      <td
                        key={c.key}
                        style={{
                          maxWidth: ["test_scenario", "expected_result", "newly_generated_expected_result", "actual_result"].includes(c.key) ? 220 : undefined,
                          fontSize: 11,
                          whiteSpace: "pre-wrap",
                          verticalAlign: "top",
                        }}
                      >
                        {c.key === "status" ? (
                          <span className={`badge ${statusClass(row.status)}`}>{row.status}</span>
                        ) : (
                          row[c.key] ?? "—"
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
