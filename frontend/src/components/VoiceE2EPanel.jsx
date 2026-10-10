import { useCallback, useEffect, useState } from "react";
import {
  checkQaRunnerHealth,
  getRunReportUrl,
  getRunResults,
  getRunStatus,
  listSuites,
  startVoiceRun,
} from "../api/qaRunner.js";
import { DEFAULT_QA_RUNNER_URL } from "../config/qaRunner.js";

const SMOKE_SUITE_IDS = ["handle_session", "handle_weather", "handle_assistant_info"];

export default function VoiceE2EPanel({ backendUrl, addLog, showToast }) {
  const [qaRunnerUrl, setQaRunnerUrl] = useState(DEFAULT_QA_RUNNER_URL);
  const [suites, setSuites] = useState([]);
  const [selectedSuites, setSelectedSuites] = useState(SMOKE_SUITE_IDS);
  const [runnerHealth, setRunnerHealth] = useState(null);
  const [loadingSuites, setLoadingSuites] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState(null);
  const [runStatus, setRunStatus] = useState(null);
  const [results, setResults] = useState([]);

  const refreshSuites = useCallback(async () => {
    setLoadingSuites(true);
    try {
      const data = await listSuites(qaRunnerUrl);
      setSuites(data);
      addLog("ok", `Loaded ${data.length} voice E2E suite(s) from qa-runner`);
    } catch (e) {
      addLog("err", `Failed to load suites: ${e.message}`);
      showToast(`QA runner unreachable: ${e.message}`, "error");
    }
    setLoadingSuites(false);
  }, [qaRunnerUrl, addLog, showToast]);

  const checkRunner = useCallback(async () => {
    try {
      const health = await checkQaRunnerHealth(qaRunnerUrl);
      setRunnerHealth(health);
      addLog("ok", `QA runner healthy — cara_backend: ${health.cara_backend_exists ? "found" : "missing"}`);
      if (!health.cara_backend_exists) {
        showToast("cara_backend path not found — set CARA_BACKEND_PATH", "error");
      }
      return health;
    } catch (e) {
      setRunnerHealth(null);
      addLog("err", `QA runner health check failed: ${e.message}`);
      showToast(`QA runner offline: ${e.message}`, "error");
      throw e;
    }
  }, [qaRunnerUrl, addLog, showToast]);

  useEffect(() => {
    checkRunner()
      .then(() => refreshSuites())
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeRunId || !running) return undefined;

    const interval = setInterval(async () => {
      try {
        const status = await getRunStatus(activeRunId, qaRunnerUrl);
        setRunStatus(status);
        if (status.status === "done" || status.status === "failed") {
          setRunning(false);
          const cases = await getRunResults(activeRunId, qaRunnerUrl);
          setResults(cases);
          const summary = status.summary || {};
          addLog(
            status.status === "done" ? "ok" : "err",
            `Voice E2E run ${activeRunId} finished — ${summary.passed ?? 0} passed, ${summary.failed ?? 0} failed`
          );
        }
      } catch (e) {
        addLog("err", `Run poll failed: ${e.message}`);
        setRunning(false);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [activeRunId, running, qaRunnerUrl, addLog]);

  function toggleSuite(id) {
    setSelectedSuites((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }

  async function startRun() {
    if (!selectedSuites.length || running) return;
    setRunning(true);
    setRunStatus(null);
    setResults([]);
    addLog("accent", `Starting voice E2E run (${selectedSuites.length} suite(s)) against ${backendUrl}`);
    try {
      const health = await checkRunner();
      if (!health.cara_backend_exists) {
        throw new Error("cara_backend not found on disk for qa-runner");
      }
      const { runId } = await startVoiceRun({
        baseUrl: qaRunnerUrl,
        caraApiUrl: backendUrl,
        suites: selectedSuites,
      });
      setActiveRunId(runId);
      addLog("info", `Voice E2E run queued: ${runId}`);
      showToast(`Voice E2E run started (${runId})`, "success");
    } catch (e) {
      addLog("err", `Failed to start voice E2E run: ${e.message}`);
      showToast(e.message, "error");
      setRunning(false);
    }
  }

  const progress = runStatus?.progress;
  const summary = runStatus?.summary;

  return (
    <div className="stack fade-in" style={{ gap: 20 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Voice E2E (LiveKit)</div>
            <div className="card-sub">
              Runs cara_backend voice suites via qa-runner — requires API + agent worker
            </div>
          </div>
          <button className="btn btn-secondary" onClick={() => checkRunner().then(refreshSuites)} disabled={loadingSuites}>
            Refresh
          </button>
        </div>

        <div className="grid-2" style={{ gap: 12 }}>
          <div className="form-group">
            <label className="form-label">cara_backend API URL</label>
            <input className="form-input" value={backendUrl} readOnly />
          </div>
          <div className="form-group">
            <label className="form-label">QA Runner URL</label>
            <input
              className="form-input"
              value={qaRunnerUrl}
              onChange={(e) => setQaRunnerUrl(e.target.value)}
              placeholder="http://127.0.0.1:3001"
            />
          </div>
        </div>

        {runnerHealth && (
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--text3)", fontFamily: "var(--mono)" }}>
            cara_backend path: {runnerHealth.cara_backend}
            {runnerHealth.cara_backend_exists ? " ✓" : " (not found)"}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">Suites</div>
          <button
            className="btn btn-primary"
            onClick={startRun}
            disabled={running || !selectedSuites.length || loadingSuites}
          >
            {running ? "Running…" : "▶ Run Voice E2E"}
          </button>
        </div>

        {loadingSuites && <div style={{ color: "var(--text3)", fontSize: 12 }}>Loading suites…</div>}

        {!loadingSuites && suites.length === 0 && (
          <div style={{ color: "var(--text3)", fontSize: 12 }}>
            No suites found. Start qa-runner and ensure cara_backend is on disk.
          </div>
        )}

        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          {suites.map((suite) => (
            <label
              key={suite.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                background: "var(--surface2)",
                borderRadius: "var(--r2)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={selectedSuites.includes(suite.id)}
                onChange={() => toggleSuite(suite.id)}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{suite.name}</div>
                <div style={{ fontSize: 11, color: "var(--text3)", fontFamily: "var(--mono)" }}>
                  {suite.id} · {suite.caseCount} case(s){suite.isSmoke ? " · smoke" : ""}
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {(running || runStatus) && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Run Status {activeRunId ? `· ${activeRunId}` : ""}</div>
            {activeRunId && runStatus?.status === "done" && (
              <a
                className="btn btn-secondary"
                href={getRunReportUrl(activeRunId, qaRunnerUrl)}
                target="_blank"
                rel="noreferrer"
              >
                Open HTML Report
              </a>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--text3)", fontFamily: "var(--mono)" }}>
            Status: {runStatus?.status || "starting"}
            {runStatus?.currentSuite ? ` · current: ${runStatus.currentSuite}` : ""}
            {progress ? ` · ${progress.completed}/${progress.total} suites` : ""}
          </div>
          {summary && (
            <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
              <span>Total: {summary.total ?? 0}</span>
              <span style={{ color: "var(--accent3)" }}>Passed: {summary.passed ?? 0}</span>
              <span style={{ color: "var(--danger)" }}>Failed: {summary.failed ?? 0}</span>
            </div>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Results ({results.length})</div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Suite</th>
                  <th>Case</th>
                  <th>Status</th>
                  <th>Accuracy</th>
                  <th>Input</th>
                  <th>Output</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row, i) => (
                  <tr key={`${row.suite}-${row.case_id}-${i}`}>
                    <td className="td-mono">{row.suite}</td>
                    <td className="td-mono">{row.case_id}</td>
                    <td>
                      <span
                        className={`badge ${row.status === "PASS" ? "badge-pass" : "badge-fail"}`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="td-mono">{row.accuracy_percent ?? "—"}%</td>
                    <td style={{ maxWidth: 200, fontSize: 12 }}>{row.input}</td>
                    <td style={{ maxWidth: 260, fontSize: 12 }}>{row.output}</td>
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
