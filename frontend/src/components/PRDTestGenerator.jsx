/**
 * PRDTestGenerator.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * 5-step wizard: PRD → Requirements → Test Cases → Run (opt-in) → Report
 *
 * Pipelines are isolated by default:
 *   • Generate stops after test-case review (no auto regression).
 *   • Import and Run are separate steps; Run requires checkbox + confirm dialog.
 *
 * Props:
 *   onImport(testCases)          — called when TCs are imported to the project
 *   qaRunnerBase                 — base URL of the qa-runner API (default: http://localhost:3001)
 *   existingIds                  — Set<string> of existing TC IDs
 *   config                       — { backendUrl, deviceId, ... }
 *   brand                        — project brand string
 *   evaluateResultFn             — evaluateResult(data, tc) from evaluateTestResult.js
 *   deviceIdForTestCaseFn        — deviceIdForTestCase(tc, baseId)
 *   downloadAllureReportFn       — downloadAllureReport(reportData, filename, format)
 */

import React, { useCallback, useRef, useState } from "react";
import { processTextTurns } from "../api/caraBackend.js";

const QA_RUNNER_DEFAULT = "http://localhost:3001";
const STEP_LABELS = ["Document", "Requirements", "Test Cases", "Run Tests", "Report"];

// ── PDF / DOCX extraction ─────────────────────────────────────────────────────
async function readFileAsText(file) {
  if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
    return await extractPdf(file);
  }
  if (
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    file.name.endsWith(".docx")
  ) {
    return await extractDocx(file);
  }
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("Failed to read file"));
    r.readAsText(file);
  });
}

async function extractPdf(file) {
  if (typeof window.pdfjsLib === "undefined") {
    throw new Error("PDF.js not loaded. Add it to index.html (see README).");
  }
  const buf    = await file.arrayBuffer();
  const pdf    = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const pages  = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map(i => i.str).join(" "));
  }
  return pages.join("\n\n");
}

async function extractDocx(file) {
  if (typeof window.mammoth === "undefined") {
    throw new Error("mammoth.js not loaded. Add it to index.html (see README).");
  }
  const buf    = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return result.value;
}

// ── Badge helpers ─────────────────────────────────────────────────────────────
const PRIORITY_STYLE = {
  P1: { background: "rgba(239,68,68,0.12)",   color: "#ef4444" },
  P2: { background: "rgba(245,158,11,0.12)",  color: "#f59e0b" },
  P3: { background: "rgba(99,102,241,0.12)",  color: "#6366f1" },
};
const TYPE_STYLE = {
  Positive:  { background: "rgba(16,185,129,0.12)", color: "#10b981" },
  Negative:  { background: "rgba(239,68,68,0.12)",  color: "#ef4444" },
  Boundary:  { background: "rgba(245,158,11,0.12)", color: "#f59e0b" },
};

const PriBadge = ({ p }) => (
  <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 7px", ...(PRIORITY_STYLE[p] || PRIORITY_STYLE.P3) }}>{p}</span>
);
const TypeBadge = ({ t }) => (
  <span style={{ fontSize: 10, fontWeight: 600, borderRadius: 4, padding: "2px 7px", ...(TYPE_STYLE[t] || TYPE_STYLE.Boundary) }}>{t}</span>
);

// ── Step bar ──────────────────────────────────────────────────────────────────
function StepBar({ current }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 28 }}>
      {STEP_LABELS.map((label, i) => {
        const done   = i < current;
        const active = i === current;
        const last   = i === STEP_LABELS.length - 1;
        return (
          <React.Fragment key={i}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 70 }}>
              <div style={{
                width: 32, height: 32, borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontWeight: 700, fontSize: 13, transition: "all 0.25s",
                background: done ? "var(--accent3)" : active ? "var(--accent)" : "var(--surface2)",
                color: done || active ? "#fff" : "var(--text3)",
                border: active ? "2px solid var(--accent)" : "none",
              }}>
                {done ? "✓" : i + 1}
              </div>
              <div style={{
                fontSize: 10, marginTop: 4, fontWeight: active ? 700 : 500,
                color: active ? "var(--accent)" : done ? "var(--accent3)" : "var(--text3)",
              }}>
                {label}
              </div>
            </div>
            {!last && (
              <div style={{
                flex: 1, height: 2, margin: "-16px 0 0",
                background: done ? "var(--accent3)" : "var(--surface2)",
                transition: "background 0.25s",
              }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Drop zone ─────────────────────────────────────────────────────────────────
function DropZone({ onFile, loading }) {
  const [over, setOver] = useState(false);
  const inp = useRef(null);
  const handleDrop = useCallback(async (e) => {
    e.preventDefault(); setOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  }, [onFile]);
  return (
    <div
      style={{
        border: `2px dashed ${over ? "var(--accent)" : "var(--surface3)"}`,
        borderRadius: 12, padding: "32px 24px", textAlign: "center", cursor: "pointer",
        background: over ? "rgba(99,102,241,0.06)" : "var(--surface2)", transition: "all 0.2s",
      }}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      onClick={() => !loading && inp.current?.click()}
    >
      <input ref={inp} type="file" accept=".pdf,.docx,.txt,.md" hidden
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      <div style={{ fontSize: 36, marginBottom: 8 }}>📄</div>
      <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Drop your PRD here or click to browse</div>
      <div style={{ fontSize: 12, color: "var(--text3)" }}>Supports PDF, DOCX, TXT, Markdown</div>
    </div>
  );
}

// ── CSV Download helper ───────────────────────────────────────────────────────
function downloadCSV(results, testCases) {
  const rows = [
    ["TC ID","Module","Flow","Type","Voice Input","Expected Intent","Actual Intent","Tool","Status","Confidence","Response","Error"],
    ...testCases.map(tc => {
      const r = results[tc.id];
      return [
        tc.id, tc.module, tc.flow || "Single-Turn", tc.testType || "",
        `"${(tc.input || "").replace(/"/g, '""')}"`,
        tc.expectedIntent,
        r?.actualIntent || "",
        r?.toolCheck?.actualTool || "",
        r ? (r.pass ? "PASS" : "FAIL") : "PENDING",
        r?.confidence || 0,
        `"${(r?.message || r?.error || "").replace(/"/g, '""')}"`,
        `"${(r?.error || "").replace(/"/g, '""')}"`,
      ].join(",");
    }),
  ].join("\n");
  const blob = new Blob([rows], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `prd_test_results_${Date.now()}.csv`;
  a.click();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Main Component
// ═══════════════════════════════════════════════════════════════════════════════
export default function PRDTestGenerator({
  onImport,
  qaRunnerBase,
  existingIds = new Set(),
  config,
  brand,
  evaluateResultFn,
  deviceIdForTestCaseFn,
  downloadAllureReportFn,
}) {
  const BASE = qaRunnerBase || QA_RUNNER_DEFAULT;

  // ── Wizard state ────────────────────────────────────────────────────────────
  const [step,       setStep]       = useState(0);
  const [loading,    setLoading]    = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error,      setError]      = useState("");

  // Step 1
  const [prdText,    setPrdText]    = useState("");
  const [fileName,   setFileName]   = useState("");
  const [prdPreview, setPrdPreview] = useState("");

  // Step 2
  const [requirements, setRequirements] = useState([]);
  const [reqSelected,  setReqSelected]  = useState(new Set());

  // Step 3
  const [testCases,  setTestCases]  = useState([]);
  const [tcSelected, setTcSelected] = useState(new Set());
  const [tcFilter,   setTcFilter]   = useState({ module: "", priority: "", type: "" });
  const [editingTc,  setEditingTc]  = useState(null);

  // Step 4 — Run (explicit opt-in; never auto-chained after generate)
  const [runResults,   setRunResults]   = useState({});
  const [runProgress,  setRunProgress]  = useState(0);
  const [currentTcId,  setCurrentTcId]  = useState(null);
  const [isRunning,    setIsRunning]    = useState(false);
  const [importedToProject, setImportedToProject] = useState(false);
  const [importedCount,     setImportedCount]     = useState(0);
  const [runConfirmChecked, setRunConfirmChecked] = useState(false);
  const stopRequested = useRef(false);

  // Step 5 — final summary
  const [reportData, setReportData] = useState(null);

  // ── QA-runner API call ──────────────────────────────────────────────────────
  async function callApi(path, body) {
    const resp = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(detail.detail || resp.statusText);
    }
    return resp.json();
  }

  // ── Step 1 → read document ──────────────────────────────────────────────────
  async function handleFile(file) {
    setError(""); setLoading(true); setLoadingMsg("Reading document…");
    try {
      const text = await readFileAsText(file);
      setPrdText(text); setFileName(file.name); setPrdPreview(text.slice(0, 800));
    } catch (e) { setError(e.message); }
    setLoading(false); setLoadingMsg("");
  }

  // ── Step 1 → 2: extract requirements ────────────────────────────────────────
  async function extractRequirements() {
    if (!prdText.trim()) { setError("Please provide PRD content."); return; }
    setError(""); setLoading(true); setLoadingMsg("Analysing PRD with AI — extracting requirements…");
    try {
      const data = await callApi("/prd/extract-requirements", { prdText });
      setRequirements(data.requirements || []);
      setReqSelected(new Set((data.requirements || []).map(r => r.id)));
      setStep(1);
    } catch (e) { setError(`Extract failed: ${e.message}`); }
    setLoading(false); setLoadingMsg("");
  }

  // ── Step 2 → 3: generate test cases ─────────────────────────────────────────
  async function generateTestCases() {
    const selected = requirements.filter(r => reqSelected.has(r.id));
    if (!selected.length) { setError("Select at least one requirement."); return; }
    const expected = selected.reduce((s, r) => s + (r.priority === "P1" ? 3 : r.priority === "P2" ? 2 : 1), 0);
    setError(""); setLoading(true);
    setLoadingMsg(`Generating test cases for ${selected.length} requirements (expecting ~${expected} TCs)…`);
    try {
      const data = await callApi("/prd/generate-test-cases", { requirements: selected });
      const tcs  = (data.test_cases || []).map(tc => ({ ...tc, _dirty: false }));
      setTestCases(tcs);
      setTcSelected(new Set(tcs.map(tc => tc.id)));
      setStep(2);
    } catch (e) { setError(`Generation failed: ${e.message}`); }
    setLoading(false); setLoadingMsg("");
  }

  // ── Step 2 → 3: import only (no regression / agent OpenAI calls) ───────────
  function importToProject() {
    const toImport = testCases.filter(tc => tcSelected.has(tc.id));
    if (!toImport.length) { setError("Select at least one test case."); return; }
    onImport(toImport);
    setImportedToProject(true);
    setImportedCount(toImport.length);
    setRunConfirmChecked(false);
    setRunResults({});
    setRunProgress(0);
    setReportData(null);
    setStep(3);
    setError("");
  }

  // ── Step 3: run selected TCs — explicit opt-in; confirm before agent calls ─
  async function runSelectedTests() {
    const toRun = testCases.filter(tc => tcSelected.has(tc.id));
    if (!toRun.length) { setError("Select at least one test case."); return; }
    if (!runConfirmChecked) {
      setError("Check the confirmation box to acknowledge OpenAI agent usage.");
      return;
    }

    const ok = window.confirm(
      `Run ${toRun.length} test case(s) through the CARA regression agent?\n\n` +
      `This will call POST /process-text for each case (OpenAI agent loop, 1–5 calls per case).\n\n` +
      `Continue?`
    );
    if (!ok) return;

    setError("");
    setRunResults({});
    setRunProgress(0);
    setIsRunning(true);
    stopRequested.current = false;

    const results = {};
    const backendConfig = config || { backendUrl: "http://localhost:9090", deviceId: "prd-regression" };

    for (let i = 0; i < toRun.length; i++) {
      if (stopRequested.current) break;

      const tc = toRun[i];
      setCurrentTcId(tc.id);

      try {
        const deviceId = deviceIdForTestCaseFn
          ? deviceIdForTestCaseFn(tc, backendConfig.deviceId)
          : `${backendConfig.deviceId || "prd-runner"}-${tc.id}`;

        const data = await processTextTurns({
          config: backendConfig,
          brand: brand || "generic",
          deviceId,
          testCase: tc,
        });

        const evalResult = evaluateResultFn
          ? evaluateResultFn(data, tc)
          : _defaultEval(data, tc);

        results[tc.id] = { ...evalResult, raw: data, timestamp: new Date().toISOString() };
      } catch (e) {
        results[tc.id] = {
          pass: false, intentMatch: false, confidence: 0,
          error: e.message, actualIntent: "error", message: "",
        };
      }

      setRunResults({ ...results });
      setRunProgress(Math.round(((i + 1) / toRun.length) * 100));
      await new Promise(r => setTimeout(r, 500));
    }

    setCurrentTcId(null);
    setIsRunning(false);

    const pass  = Object.values(results).filter(r => r.pass).length;
    const fail  = Object.values(results).filter(r => !r.pass).length;
    const total = Object.keys(results).length;
    const rd = {
      pass, fail, total,
      passPct: total > 0 ? Math.round((pass / total) * 100) : 0,
      results,
      runAt: new Date().toLocaleString(),
      testCases: toRun,
    };
    setReportData(rd);
    setStep(4);
  }

  // ── Minimal fallback evaluator (used when evaluateResultFn not provided) ────
  function _defaultEval(data, tc) {
    const actual   = (data?.intent || data?.type || "general_conversation").toLowerCase();
    const expected = (tc.expectedIntent || "general_conversation").toLowerCase();
    const msg      = data?.assistant?.message || data?.message || "";
    const match    = actual === expected || actual.includes(expected) || expected.includes(actual);
    const conf     = match ? 80 : 30;
    return { pass: match, intentMatch: match, confidence: conf, actualIntent: actual, message: msg };
  }

  // ── Inline TC edit ──────────────────────────────────────────────────────────
  function updateTc(id, field, value) {
    setTestCases(prev => prev.map(tc => tc.id === id ? { ...tc, [field]: value, _dirty: true } : tc));
  }

  // ── Derived values ──────────────────────────────────────────────────────────
  const modules = [...new Set(testCases.map(tc => tc.module))].sort();
  const filteredTcs = testCases.filter(tc => {
    if (tcFilter.module   && tc.module   !== tcFilter.module)   return false;
    if (tcFilter.priority && tc.priority !== tcFilter.priority) return false;
    if (tcFilter.type     && tc.testType !== tcFilter.type)     return false;
    return true;
  });
  const byModule   = {};
  const byPriority = { P1: 0, P2: 0, P3: 0 };
  testCases.forEach(tc => {
    byModule[tc.module]          = (byModule[tc.module] || 0) + 1;
    if (byPriority[tc.priority] !== undefined) byPriority[tc.priority]++;
  });

  const runTcs       = testCases.filter(tc => tcSelected.has(tc.id));
  const runPass      = Object.values(runResults).filter(r => r.pass).length;
  const runFail      = Object.values(runResults).filter(r => !r.pass).length;
  const runCompleted = Object.keys(runResults).length;

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="stack fade-in" style={{ gap: 20 }}>

      <StepBar current={step} />

      {/* Error banner */}
      {error && (
        <div style={{
          background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 8, padding: "10px 16px", color: "#ef4444", fontSize: 13,
          display: "flex", gap: 8, alignItems: "flex-start",
        }}>
          <span style={{ fontSize: 16 }}>⚠</span>
          <span style={{ flex: 1 }}>{error}</span>
          <button style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 16 }} onClick={() => setError("")}>✕</button>
        </div>
      )}

      {/* Loading spinner */}
      {loading && (
        <div className="card" style={{ textAlign: "center", padding: "36px 24px" }}>
          <div className="spinner" style={{ width: 40, height: 40, margin: "0 auto 16px", borderWidth: 3 }} />
          <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{loadingMsg}</div>
          <div style={{ fontSize: 12, color: "var(--text3)" }}>This may take 20–60 seconds depending on document size</div>
        </div>
      )}

      {/* ══ STEP 0: Document Input ═══════════════════════════════════════════════ */}
      {!loading && step === 0 && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">📄 Upload PRD Document</div>
                <div className="card-sub">Drop a PDF, DOCX, or TXT file — or paste content below</div>
              </div>
            </div>

            <DropZone onFile={handleFile} loading={loading} />

            {prdPreview && (
              <div style={{ marginTop: 16, background: "var(--surface2)", borderRadius: 8, padding: "12px 14px", maxHeight: 180, overflowY: "auto" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>{fileName} — Preview</span>
                  <button className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => { setPrdText(""); setPrdPreview(""); setFileName(""); }}>Clear</button>
                </div>
                <pre style={{ fontSize: 11, color: "var(--text3)", whiteSpace: "pre-wrap", margin: 0 }}>
                  {prdPreview}
                  {prdText.length > 800 && <span style={{ color: "var(--accent3)" }}> … ({prdText.length.toLocaleString()} chars total)</span>}
                </pre>
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text3)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>— Or paste content directly —</div>
              <textarea
                className="form-input"
                style={{ minHeight: 140, fontFamily: "var(--mono)", fontSize: 12, resize: "vertical" }}
                placeholder={"Paste your PRD text here…\n\nExample:\nFeature: Navigation\nThe system shall allow the user to request voice navigation to any destination."}
                value={prdText}
                onChange={e => {
                  setPrdText(e.target.value);
                  if (!fileName) setFileName("(pasted text)");
                  setPrdPreview(e.target.value.slice(0, 800));
                }}
              />
            </div>

            <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
              <button className="btn btn-primary" onClick={extractRequirements} disabled={!prdText.trim() || loading} style={{ minWidth: 200 }}>
                🔍 Extract Requirements →
              </button>
              <span style={{ fontSize: 12, color: "var(--text3)" }}>
                {prdText.trim() ? `${prdText.length.toLocaleString()} characters ready` : "Awaiting document…"}
              </span>
            </div>
          </div>

          {/* How it works */}
          <div className="card" style={{ border: "1px solid rgba(99,102,241,0.2)", background: "rgba(99,102,241,0.04)" }}>
            <div className="card-title" style={{ fontSize: 13, marginBottom: 10 }}>💡 How it works</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
              {[
                { icon: "📄", title: "Upload PRD",  desc: "Drop any product requirements doc" },
                { icon: "🔍", title: "AI Analysis", desc: "GPT-4o extracts testable requirements" },
                { icon: "🧪", title: "Generate TCs", desc: "3 TCs per P1, 2 per P2, 1 per P3" },
                { icon: "▶",  title: "Auto-Run",     desc: "Executes all TCs against CARA backend" },
                { icon: "📊", title: "Report",       desc: "Allure HTML + CSV report download" },
              ].map(s => (
                <div key={s.title} style={{ textAlign: "center", padding: "10px 8px" }}>
                  <div style={{ fontSize: 24, marginBottom: 6 }}>{s.icon}</div>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "var(--text)", marginBottom: 4 }}>{s.title}</div>
                  <div style={{ fontSize: 11, color: "var(--text3)" }}>{s.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══ STEP 1: Requirements Review ══════════════════════════════════════════ */}
      {!loading && step === 1 && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">📋 Extracted Requirements</div>
                <div className="card-sub">{requirements.length} requirements · select which to generate test cases for</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => setReqSelected(new Set(requirements.map(r => r.id)))}>All</button>
                <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => setReqSelected(new Set())}>None</button>
                <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => { setStep(0); setRequirements([]); }}>← Back</button>
              </div>
            </div>

            {(() => {
              const byCategory = {};
              requirements.forEach(r => { if (!byCategory[r.category]) byCategory[r.category] = []; byCategory[r.category].push(r); });
              return Object.entries(byCategory).map(([cat, reqs]) => (
                <div key={cat} style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "var(--accent)", marginBottom: 8, borderBottom: "1px solid var(--surface3)", paddingBottom: 4 }}>
                    {cat} <span style={{ color: "var(--text3)", fontWeight: 400 }}>({reqs.length})</span>
                  </div>
                  <div className="stack" style={{ gap: 8 }}>
                    {reqs.map(req => (
                      <div key={req.id}
                        style={{
                          display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer", borderRadius: 8,
                          padding: "10px 14px", transition: "all 0.15s",
                          background: reqSelected.has(req.id) ? "rgba(99,102,241,0.06)" : "var(--surface2)",
                          border: `1px solid ${reqSelected.has(req.id) ? "rgba(99,102,241,0.25)" : "transparent"}`,
                        }}
                        onClick={() => setReqSelected(prev => { const n = new Set(prev); n.has(req.id) ? n.delete(req.id) : n.add(req.id); return n; })}
                      >
                        <input type="checkbox" checked={reqSelected.has(req.id)} readOnly style={{ marginTop: 3, accentColor: "var(--accent)", flexShrink: 0 }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text3)" }}>{req.id}</span>
                            <PriBadge p={req.priority} />
                            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{req.title}</span>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--text3)" }}>{req.description}</div>
                          {req.acceptance && <div style={{ fontSize: 11, color: "var(--accent3)", marginTop: 4 }}>✓ {req.acceptance}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ));
            })()}
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn btn-primary" onClick={generateTestCases} disabled={!reqSelected.size || loading} style={{ minWidth: 240 }}>
              🧪 Generate Test Cases ({reqSelected.size} reqs) →
            </button>
            <span style={{ fontSize: 12, color: "var(--text3)" }}>
              ~{requirements.filter(r => reqSelected.has(r.id)).reduce((s, r) => s + (r.priority === "P1" ? 3 : r.priority === "P2" ? 2 : 1), 0)} test cases expected
            </span>
          </div>
        </div>
      )}

      {/* ══ STEP 2: Test Cases Review ═════════════════════════════════════════════ */}
      {!loading && step === 2 && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid-4">
            <div className="stat"><div className="stat-val">{testCases.length}</div><div className="stat-label">Generated</div></div>
            <div className="stat red"><div className="stat-val">{byPriority.P1}</div><div className="stat-label">P1 Critical</div></div>
            <div className="stat accent"><div className="stat-val">{byPriority.P2}</div><div className="stat-label">P2 Important</div></div>
            <div className="stat"><div className="stat-val">{byPriority.P3}</div><div className="stat-label">P3 Nice-to-have</div></div>
          </div>

          <div className="card" style={{ padding: "12px 16px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>By Module:</span>
              {Object.entries(byModule).map(([mod, cnt]) => (
                <span key={mod} className="chip" style={{ fontSize: 11 }}>{mod} <strong style={{ marginLeft: 4 }}>{cnt}</strong></span>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">🧪 Generated Test Cases</div>
                <div className="card-sub">{tcSelected.size} / {testCases.length} selected</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select className="form-select" style={{ fontSize: 11, padding: "4px 8px" }} value={tcFilter.module} onChange={e => setTcFilter(p => ({ ...p, module: e.target.value }))}>
                  <option value="">All Modules</option>{modules.map(m => <option key={m}>{m}</option>)}
                </select>
                <select className="form-select" style={{ fontSize: 11, padding: "4px 8px" }} value={tcFilter.priority} onChange={e => setTcFilter(p => ({ ...p, priority: e.target.value }))}>
                  <option value="">All Priorities</option><option>P1</option><option>P2</option><option>P3</option>
                </select>
                <select className="form-select" style={{ fontSize: 11, padding: "4px 8px" }} value={tcFilter.type} onChange={e => setTcFilter(p => ({ ...p, type: e.target.value }))}>
                  <option value="">All Types</option><option>Positive</option><option>Negative</option><option>Boundary</option>
                </select>
                <button className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => setTcSelected(new Set(filteredTcs.map(t => t.id)))}>Select Visible</button>
                <button className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => setTcSelected(new Set())}>None</button>
                <button className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => { setStep(1); setTestCases([]); }}>← Back</button>
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th>TC ID</th><th>Module</th><th>Type</th><th>Priority</th>
                    <th>Voice Input</th><th>Expected Intent</th><th>Expected Response</th>
                    <th>Req</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTcs.map(tc => {
                    const editing = editingTc === tc.id;
                    const dup     = existingIds.has(tc.id);
                    return (
                      <tr key={tc.id} style={{ opacity: tcSelected.has(tc.id) ? 1 : 0.45, background: dup ? "rgba(245,158,11,0.06)" : undefined }}>
                        <td>
                          <input type="checkbox" checked={tcSelected.has(tc.id)} style={{ accentColor: "var(--accent)" }}
                            onChange={() => setTcSelected(prev => { const n = new Set(prev); n.has(tc.id) ? n.delete(tc.id) : n.add(tc.id); return n; })} />
                        </td>
                        <td>
                          <span className="td-mono" style={{ fontSize: 10 }}>{tc.id}</span>
                          {dup && <span style={{ fontSize: 9, color: "#f59e0b", marginLeft: 4 }}>⚠ dup</span>}
                          {tc._dirty && <span style={{ fontSize: 9, color: "var(--accent)", marginLeft: 4 }}>✎</span>}
                        </td>
                        <td><span className="chip" style={{ fontSize: 10 }}>{tc.module}</span></td>
                        <td><TypeBadge t={tc.testType} /></td>
                        <td><PriBadge p={tc.priority} /></td>
                        <td style={{ maxWidth: 200 }}>
                          {editing
                            ? <input className="form-input" style={{ fontSize: 11, padding: "3px 6px" }} value={tc.input} onChange={e => updateTc(tc.id, "input", e.target.value)} />
                            : <span style={{ fontSize: 11 }}>{tc.input}</span>}
                        </td>
                        <td>
                          {editing
                            ? <input className="form-input" style={{ fontSize: 11, padding: "3px 6px" }} value={tc.expectedIntent} onChange={e => updateTc(tc.id, "expectedIntent", e.target.value)} />
                            : <span className="intent-pill" style={{ fontSize: 10 }}>{tc.expectedIntent}</span>}
                        </td>
                        <td style={{ maxWidth: 200, fontSize: 11, color: "var(--text3)" }}>
                          {editing
                            ? <textarea className="form-input" style={{ fontSize: 11, padding: "3px 6px", minHeight: 50, resize: "none" }} value={tc.expectedResponse} onChange={e => updateTc(tc.id, "expectedResponse", e.target.value)} />
                            : <>{tc.expectedResponse?.slice(0, 70)}{tc.expectedResponse?.length > 70 ? "…" : ""}</>}
                        </td>
                        <td style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)" }}>{tc.sourceRequirement || "—"}</td>
                        <td>
                          <button className="btn btn-secondary" style={{ fontSize: 10, padding: "3px 8px" }} onClick={() => setEditingTc(editing ? null : tc.id)}>
                            {editing ? "Done" : "Edit"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={importToProject} disabled={!tcSelected.size} style={{ minWidth: 200 }}>
              📥 Import to Project ({tcSelected.size})
            </button>
            <span style={{ fontSize: 12, color: "var(--text3)" }}>
              Adds selected TCs to the project only — does not run regression or call OpenAI
            </span>
          </div>
        </div>
      )}

      {/* ══ STEP 3: Run Tests (explicit opt-in — separate from import) ═══════════ */}
      {!loading && step === 3 && !isRunning && Object.keys(runResults).length === 0 && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card" style={{ padding: "16px 20px", border: "1px solid rgba(251,191,36,0.25)", background: "rgba(251,191,36,0.04)" }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: "#fbbf24", marginBottom: 8 }}>⚠ Explicit opt-in required</div>
            <div style={{ fontSize: 12, color: "var(--text3)", lineHeight: 1.6 }}>
              {importedToProject
                ? `${importedCount} test case(s) imported to the project.`
                : `${tcSelected.size} test case(s) selected.`}
              {" "}Running tests will call the CARA backend (<code>POST /process-text</code>) once per case.
              Each case may trigger 1–5 OpenAI agent calls. This step is <strong>not</strong> automatic after generation.
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 12, color: "var(--text2)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={runConfirmChecked}
              onChange={e => setRunConfirmChecked(e.target.checked)}
              style={{ marginTop: 2, accentColor: "var(--accent)" }}
            />
            <span>
              I understand this will execute <strong>{tcSelected.size}</strong> test case(s) through the
              regression agent and consume OpenAI API quota.
            </span>
          </label>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              className="btn btn-primary"
              onClick={runSelectedTests}
              disabled={!tcSelected.size || !runConfirmChecked}
              style={{ minWidth: 200 }}
            >
              ▶ Run {tcSelected.size} Test Cases
            </button>
            <button className="btn btn-secondary" onClick={() => setStep(2)}>← Back to Review</button>
          </div>
        </div>
      )}

      {/* ══ STEP 3 (active run) / STEP 4 (report): running + results ════════════ */}
      {(step === 3 && (isRunning || Object.keys(runResults).length > 0)) && (
        <div className="stack" style={{ gap: 16 }}>
          {/* Progress card */}
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">{isRunning ? "🔄 Running Test Suite…" : "✅ Run Complete"}</div>
                <div className="card-sub">
                  {isRunning
                    ? currentTcId ? `Executing: ${currentTcId}` : "Initialising…"
                    : `${runCompleted} tests executed · ${runPass} passed · ${runFail} failed`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span className="badge badge-run" style={{ fontSize: 14, padding: "4px 12px" }}>{runProgress}%</span>
                {isRunning && (
                  <button className="btn btn-danger" style={{ fontSize: 11 }} onClick={() => { stopRequested.current = true; }}>■ Stop</button>
                )}
              </div>
            </div>
            <div className="progress-bar"><div className="progress-fill" style={{ width: `${runProgress}%` }} /></div>

            {/* Live stats */}
            <div className="grid-4" style={{ marginTop: 16 }}>
              <div className="stat"><div className="stat-val">{runTcs.length}</div><div className="stat-label">Total TCs</div></div>
              <div className="stat"><div className="stat-val" style={{ color: "var(--accent3)" }}>{runCompleted}</div><div className="stat-label">Executed</div></div>
              <div className="stat green"><div className="stat-val">{runPass}</div><div className="stat-label">Pass</div></div>
              <div className="stat red"><div className="stat-val">{runFail}</div><div className="stat-label">Fail</div></div>
            </div>
          </div>

          {/* Live results table */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">Live Results</div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>TC ID</th><th>Module</th><th>Type</th><th>Voice Input</th><th>Expected Intent</th><th>Actual Intent</th><th>Status</th><th>Conf.</th><th>Response</th></tr>
                </thead>
                <tbody>
                  {runTcs.map(tc => {
                    const r         = runResults[tc.id];
                    const isRunning = currentTcId === tc.id;
                    return (
                      <tr key={tc.id} className={isRunning ? "tc-row-running" : r?.pass ? "tc-row-pass" : r ? "tc-row-fail" : ""}>
                        <td className="td-mono" style={{ fontSize: 10 }}>{tc.id}</td>
                        <td><span className="chip" style={{ fontSize: 10 }}>{tc.module}</span></td>
                        <td><TypeBadge t={tc.testType} /></td>
                        <td style={{ maxWidth: 180, fontSize: 11 }}>{tc.input}</td>
                        <td><span className="intent-pill" style={{ fontSize: 10 }}>{tc.expectedIntent}</span></td>
                        <td>
                          {r ? (
                            <span className="intent-pill" style={{
                              fontSize: 10,
                              background: r.intentMatch ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)",
                              color: r.intentMatch ? "var(--accent3)" : "var(--danger)",
                            }}>{r.actualIntent}</span>
                          ) : isRunning ? <span style={{ color: "var(--accent)", fontSize: 11 }}>running…</span> : "—"}
                        </td>
                        <td>
                          {isRunning
                            ? <span className="badge badge-run">Running</span>
                            : r
                              ? <span className={`badge ${r.pass ? "badge-pass" : "badge-fail"}`}>{r.pass ? "PASS" : "FAIL"}</span>
                              : <span className="badge badge-idle">Pending</span>}
                        </td>
                        <td className="td-mono" style={{ fontSize: 11 }}>{r ? `${r.confidence}%` : "—"}</td>
                        <td style={{ maxWidth: 220, fontSize: 11, color: "var(--text3)" }}>
                          {r?.message ? r.message.slice(0, 80) + (r.message.length > 80 ? "…" : "")
                            : r?.error ? <span style={{ color: "var(--danger)" }}>{r.error.slice(0, 60)}</span>
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══ STEP 4: Report ════════════════════════════════════════════════════════ */}
      {step === 4 && reportData && (
        <div className="stack" style={{ gap: 16 }}>
          {/* Summary hero */}
          <div className="card" style={{ background: reportData.passPct >= 80 ? "rgba(16,185,129,0.06)" : reportData.passPct >= 50 ? "rgba(245,158,11,0.06)" : "rgba(239,68,68,0.06)", border: `1px solid ${reportData.passPct >= 80 ? "rgba(16,185,129,0.2)" : reportData.passPct >= 50 ? "rgba(245,158,11,0.2)" : "rgba(239,68,68,0.2)"}` }}>
            <div style={{ textAlign: "center", padding: "24px 16px" }}>
              <div style={{ fontSize: 52, marginBottom: 8 }}>
                {reportData.passPct >= 80 ? "🎉" : reportData.passPct >= 50 ? "⚠️" : "❌"}
              </div>
              <div style={{ fontWeight: 700, fontSize: 22, color: "var(--text)", marginBottom: 4 }}>
                {reportData.passPct}% Pass Rate
              </div>
              <div style={{ fontSize: 14, color: "var(--text3)" }}>
                {reportData.pass} passed · {reportData.fail} failed · {reportData.total} total · {reportData.runAt}
              </div>
            </div>

            <div className="grid-4" style={{ marginTop: 4 }}>
              <div className="stat"><div className="stat-val">{reportData.total}</div><div className="stat-label">Total TCs</div></div>
              <div className="stat green"><div className="stat-val">{reportData.pass}</div><div className="stat-label">Passed</div></div>
              <div className="stat red"><div className="stat-val">{reportData.fail}</div><div className="stat-label">Failed</div></div>
              <div className="stat accent"><div className="stat-val">{reportData.passPct}%</div><div className="stat-label">Pass Rate</div></div>
            </div>
          </div>

          {/* Download actions */}
          <div className="card">
            <div className="card-header">
              <div><div className="card-title">📊 Download Report</div><div className="card-sub">Export in your preferred format</div></div>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                className="btn btn-success"
                style={{ minWidth: 200 }}
                onClick={() => {
                  if (downloadAllureReportFn) {
                    downloadAllureReportFn({
                      reportData,
                      testCases: reportData.testCases || runTcs,
                      projectName: "PRD Analysis",
                    });
                  } else {
                    alert("Report generator not available. Please download CSV instead.");
                  }
                }}
              >
                ↓ Allure HTML Report
              </button>
              <button
                className="btn btn-secondary"
                style={{ minWidth: 160 }}
                onClick={() => downloadCSV(reportData.results, reportData.testCases || runTcs)}
              >
                ↓ CSV Report
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  const json = JSON.stringify(reportData, null, 2);
                  const blob = new Blob([json], { type: "application/json" });
                  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
                  a.download = `prd_results_${Date.now()}.json`; a.click();
                }}
              >
                ↓ Raw JSON
              </button>
            </div>
          </div>

          {/* Full results table */}
          <div className="card">
            <div className="card-header">
              <div><div className="card-title">Test Results Detail</div></div>
              <button className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => {
                setStep(0); setPrdText(""); setPrdPreview(""); setFileName("");
                setRequirements([]); setTestCases([]); setRunResults({}); setReportData(null);
                setReqSelected(new Set()); setTcSelected(new Set());
              }}>
                ＋ Analyse Another PRD
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>TC ID</th><th>Module</th><th>Type</th><th>Priority</th><th>Voice Input</th><th>Expected Intent</th><th>Actual Intent</th><th>Status</th><th>Conf.</th><th>Response</th></tr>
                </thead>
                <tbody>
                  {(reportData.testCases || runTcs).map(tc => {
                    const r = reportData.results[tc.id];
                    return (
                      <tr key={tc.id} className={r?.pass ? "tc-row-pass" : r ? "tc-row-fail" : ""}>
                        <td className="td-mono" style={{ fontSize: 10 }}>{tc.id}</td>
                        <td><span className="chip" style={{ fontSize: 10 }}>{tc.module}</span></td>
                        <td><TypeBadge t={tc.testType} /></td>
                        <td><PriBadge p={tc.priority} /></td>
                        <td style={{ maxWidth: 200, fontSize: 11 }}>{tc.input}</td>
                        <td><span className="intent-pill" style={{ fontSize: 10 }}>{tc.expectedIntent}</span></td>
                        <td>
                          {r ? (
                            <span className="intent-pill" style={{ fontSize: 10, background: r.intentMatch ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)", color: r.intentMatch ? "var(--accent3)" : "var(--danger)" }}>
                              {r.actualIntent}
                            </span>
                          ) : "—"}
                        </td>
                        <td>{r ? <span className={`badge ${r.pass ? "badge-pass" : "badge-fail"}`}>{r.pass ? "PASS" : "FAIL"}</span> : "—"}</td>
                        <td className="td-mono" style={{ fontSize: 11 }}>{r ? `${r.confidence}%` : "—"}</td>
                        <td style={{ maxWidth: 220, fontSize: 11, color: "var(--text3)" }}>
                          {r?.message?.slice(0, 90) || (r?.error && <span style={{ color: "var(--danger)" }}>{r.error.slice(0, 60)}</span>) || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
