import { useState, useRef, useEffect, useCallback } from "react";
import { processText, processTextTurns, checkBackendHealth, saveTestRunToDB } from "./api/caraBackend.js";
import VoiceE2EPanel from "./components/VoiceE2EPanel.jsx";
import PrismPanel from "./components/PrismPanel.jsx";
import VectoraPanel from "./components/VectoraPanel.jsx";
import PRDTestGenerator from "./components/PRDTestGenerator.jsx";
import { DEFAULT_CONFIG } from "./config/backend.js";
import { deviceIdForTestCase, evaluateResult } from "./utils/evaluateTestResult.js";
import { downloadAllureReport, downloadJudgeAllureReport } from "./utils/generateAllureReport.js";

const QA_RUNNER_BASE = "http://localhost:3001";

// ─── SheetJS Loader ───────────────────────────────────────────────────────────
// Dynamically loads SheetJS from CDN so no npm install is required.
let _xlsxPromise = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error("Failed to load SheetJS"));
    document.head.appendChild(s);
  });
  return _xlsxPromise;
}

// ─── Excel / CSV Parser ───────────────────────────────────────────────────────
// Parses the CARA Regression Test Cases Excel sheet.
//
// Exact columns from CARA_Regression_Test_Cases_v2:
//   S.No | Session ID | Turn No. | Module / Feature | Test Case ID |
//   Test Category | Test Type | Conversation Flow | Voice Input (Prompt) |
//   Expected Intent | Expected Response / Behaviour | Actual Response |
//   Intent Matched? | Pass / Fail | Confidence Score | Run Date / Notes
//
// Skips header/legend rows, section-label rows (no TC ID), and result columns.
async function parseExcelBuffer(buffer, fileName) {
  const XLSX = await loadXLSX();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Parse as raw arrays so we can locate the real header row ourselves
  const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  // Find the row that contains "Test Case ID" — this is the true header row
  const headerRowIdx = allRows.findIndex(row =>
    row.some(cell => String(cell).trim() === "Test Case ID")
  );
  if (headerRowIdx === -1) {
    throw new Error(
      "Could not find header row. Make sure the sheet has a column named exactly 'Test Case ID'."
    );
  }

  const headers = allRows[headerRowIdx].map(h => String(h).trim());

  function idx(name) { return headers.indexOf(name); }

  const COL = {
    sno:              idx("S.No"),
    sessionId:        idx("Session ID"),
    turnNo:           idx("Turn No."),
    module:           idx("Module / Feature"),
    tcId:             idx("Test Case ID"),
    testCategory:     idx("Test Category"),
    testType:         idx("Test Type"),
    flow:             idx("Conversation Flow"),
    input:            idx("Voice Input (Prompt)"),
    expectedIntent:   idx("Expected Intent"),
    expectedResponse: idx("Expected Response / Behaviour"),
  };

  // Validate that the critical columns were found
  const required = ["tcId", "input", "expectedIntent", "sessionId", "turnNo", "module", "flow"];
  const missing = required.filter(k => COL[k] === -1);
  if (missing.length > 0) {
    throw new Error(`Missing required columns: ${missing.join(", ")}. Check the sheet header row.`);
  }

  function cell(row, colIdx) {
    if (colIdx === -1) return "";
    return String(row[colIdx] ?? "").trim();
  }

  const dataRows = allRows.slice(headerRowIdx + 1);

  const testCases = dataRows
    .filter(row => {
      if (row.every(c => String(c).trim() === "")) return false;   // blank row
      if (!cell(row, COL.tcId) && !cell(row, COL.sno)) return false; // section label row
      if (!cell(row, COL.input)) return false;                     // no prompt
      return true;
    })
    .map((row, i) => {
      const tcId   = cell(row, COL.tcId)  || `TC_${String(i + 1).padStart(3, "0")}`;
      const input  = cell(row, COL.input);
      const module = cell(row, COL.module) || "General";
      const rawFlow = cell(row, COL.flow) || "Single Turn";
      const flow   = /multi/i.test(rawFlow) ? "Multi-Turn" : "Single Turn";
      const sessionId = cell(row, COL.sessionId) || tcId;
      const turnNo    = parseInt(cell(row, COL.turnNo)) || 1;
      const expectedIntent    = cell(row, COL.expectedIntent)    || "general_conversation";
      const expectedResponse  = cell(row, COL.expectedResponse)  || "";
      const testCategory      = cell(row, COL.testCategory)      || "";
      const testType          = cell(row, COL.testType)          || "";

      return { id: tcId, module, input, expectedIntent, expectedResponse,
               testCategory, testType, flow, sessionId, turnNo };
    });

  if (testCases.length === 0) {
    throw new Error(
      "No valid test cases found. Check that 'Voice Input (Prompt)' and 'Test Case ID' columns have data."
    );
  }

  return testCases;
}

// ─── Design Tokens ────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;1,9..40,300&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0a0b0f;
    --surface: #111318;
    --surface2: #181c24;
    --surface3: #1e2330;
    --border: rgba(255,255,255,0.07);
    --border2: rgba(255,255,255,0.13);
    --accent: #00e5ff;
    --accent2: #7c3aed;
    --accent3: #10b981;
    --warn: #f59e0b;
    --danger: #ef4444;
    --text: #f1f5f9;
    --text2: #94a3b8;
    --text3: #475569;
    --mono: 'Space Mono', monospace;
    --sans: 'DM Sans', sans-serif;
    --r: 10px;
    --r2: 6px;
  }

  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; min-height: 100vh; }

  .app { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }

  /* Sidebar */
  .sidebar { background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .sidebar-logo { padding: 20px 20px 16px; border-bottom: 1px solid var(--border); }
  .logo-mark { font-family: var(--mono); font-size: 18px; font-weight: 700; color: var(--accent); letter-spacing: -0.5px; }
  .logo-sub { font-size: 10px; color: var(--text3); letter-spacing: 2px; text-transform: uppercase; margin-top: 2px; }
  .sidebar-section { padding: 16px 12px 8px; }
  .sidebar-section-label { font-size: 10px; color: var(--text3); letter-spacing: 2px; text-transform: uppercase; padding: 0 8px 8px; font-family: var(--mono); }
  .nav-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--r2); cursor: pointer; transition: all 0.15s; color: var(--text2); font-size: 13px; border: 1px solid transparent; }
  .nav-item:hover { background: var(--surface2); color: var(--text); }
  .nav-item.active { background: rgba(0,229,255,0.08); color: var(--accent); border-color: rgba(0,229,255,0.2); }
  .nav-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.5; flex-shrink: 0; }
  .nav-item.active .nav-dot { opacity: 1; }
  .sidebar-footer { margin-top: auto; padding: 16px; border-top: 1px solid var(--border); }
  .config-badge { font-family: var(--mono); font-size: 10px; color: var(--text3); display: flex; align-items: center; gap: 6px; }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent3); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Project Selector */
  .project-selector { padding: 12px 12px 0; }
  .project-select-label { font-size: 10px; color: var(--text3); letter-spacing: 2px; text-transform: uppercase; padding: 0 4px 6px; font-family: var(--mono); }
  .project-dropdown-wrap { position: relative; }
  .project-dropdown-btn { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: var(--r2); background: var(--surface2); border: 1px solid var(--border2); color: var(--text); font-size: 13px; cursor: pointer; transition: all 0.15s; font-family: var(--sans); }
  .project-dropdown-btn:hover { border-color: var(--accent); }
  .project-dropdown-menu { position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--r2); z-index: 100; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  .project-dropdown-item { padding: 9px 12px; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; color: var(--text2); transition: background 0.1s; }
  .project-dropdown-item:hover { background: var(--surface3); color: var(--text); }
  .project-dropdown-item.selected { color: var(--accent); background: rgba(0,229,255,0.06); }
  .project-dropdown-divider { height: 1px; background: var(--border); margin: 4px 0; }
  .project-dropdown-add { padding: 9px 12px; font-size: 12px; cursor: pointer; color: var(--accent3); display: flex; align-items: center; gap: 6px; transition: background 0.1s; font-family: var(--mono); }
  .project-dropdown-add:hover { background: var(--surface3); }

  /* Main */
  .main { display: flex; flex-direction: column; min-height: 100vh; }
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 16px 28px; border-bottom: 1px solid var(--border); background: var(--surface); position: sticky; top: 0; z-index: 10; }
  .page-title { font-size: 15px; font-weight: 700; color: var(--text); }
  .page-sub { font-size: 12px; color: var(--text3); margin-top: 1px; font-family: var(--mono); }
  .topbar-actions { display: flex; gap: 8px; align-items: center; }

  /* Buttons */
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: var(--r2); font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.15s; border: 1px solid; letter-spacing: 0.3px; font-family: var(--sans); }
  .btn-primary { background: var(--accent); color: #000; border-color: var(--accent); }
  .btn-primary:hover:not(:disabled) { background: #33ecff; }
  .btn-secondary { background: transparent; color: var(--text2); border-color: var(--border2); }
  .btn-secondary:hover:not(:disabled) { background: var(--surface2); color: var(--text); }
  .btn-danger { background: rgba(239,68,68,0.1); color: var(--danger); border-color: rgba(239,68,68,0.3); }
  .btn-danger:hover:not(:disabled) { background: rgba(239,68,68,0.2); }
  .btn-success { background: rgba(16,185,129,0.1); color: var(--accent3); border-color: rgba(16,185,129,0.3); }
  .btn-success:hover:not(:disabled) { background: rgba(16,185,129,0.2); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-icon { padding: 7px; }

  /* Content area */
  .content { padding: 24px 28px; flex: 1; }

  /* Cards */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 20px; }
  .card-sm { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--r2); padding: 14px 16px; }
  .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .card-title { font-size: 13px; font-weight: 700; color: var(--text); }
  .card-sub { font-size: 12px; color: var(--text3); margin-top: 2px; }

  /* Grid layouts */
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3,1fr); gap: 16px; }
  .grid-4 { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; }
  .stack { display: flex; flex-direction: column; gap: 12px; }
  .row { display: flex; gap: 12px; align-items: center; }
  .row-between { display: flex; justify-content: space-between; align-items: center; }

  /* Stat cards */
  .stat { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--r); padding: 16px; }
  .stat-val { font-size: 28px; font-weight: 700; font-family: var(--mono); color: var(--text); line-height: 1; }
  .stat-label { font-size: 11px; color: var(--text3); margin-top: 6px; letter-spacing: 0.5px; text-transform: uppercase; }
  .stat.accent .stat-val { color: var(--accent); }
  .stat.green .stat-val { color: var(--accent3); }
  .stat.red .stat-val { color: var(--danger); }
  .stat.warn .stat-val { color: var(--warn); }

  /* Form elements */
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 11px; color: var(--text2); letter-spacing: 0.5px; text-transform: uppercase; font-family: var(--mono); }
  .form-input { background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--r2); padding: 8px 12px; color: var(--text); font-size: 13px; font-family: var(--sans); outline: none; transition: border-color 0.15s; width: 100%; }
  .form-input:focus { border-color: var(--accent); }
  .form-input::placeholder { color: var(--text3); }
  .form-select { background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--r2); padding: 8px 12px; color: var(--text); font-size: 13px; outline: none; cursor: pointer; width: 100%; font-family: var(--sans); }
  .form-textarea { background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--r2); padding: 8px 12px; color: var(--text); font-size: 13px; font-family: var(--mono); resize: vertical; outline: none; width: 100%; }
  .form-textarea:focus { border-color: var(--accent); }

  /* Badges */
  .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; font-family: var(--mono); }
  .badge-pass { background: rgba(16,185,129,0.15); color: var(--accent3); }
  .badge-fail { background: rgba(239,68,68,0.15); color: var(--danger); }
  .badge-review { background: rgba(251,191,36,0.15); color: #fbbf24; border: 1px solid rgba(251,191,36,0.3); font-size: 9px; padding: 1px 5px; border-radius: 4px; margin-left: 4px; cursor: help; }
  .badge-skip { background: rgba(245,158,11,0.15); color: var(--warn); }
  .badge-run { background: rgba(0,229,255,0.15); color: var(--accent); }
  .badge-idle { background: rgba(255,255,255,0.05); color: var(--text3); }
  .badge-partial { background: rgba(124,58,237,0.15); color: #a78bfa; }

  /* Table */
  .table-wrap { overflow-x: auto; border-radius: var(--r); border: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; }
  th { background: var(--surface2); font-size: 10px; font-weight: 700; color: var(--text3); text-transform: uppercase; letter-spacing: 1px; padding: 10px 14px; text-align: left; font-family: var(--mono); white-space: nowrap; border-bottom: 1px solid var(--border); }
  td { padding: 10px 14px; font-size: 12px; color: var(--text2); border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .td-mono { font-family: var(--mono); font-size: 11px; }

  /* Terminal / log */
  .terminal { background: #090b0e; border: 1px solid var(--border); border-radius: var(--r); padding: 16px; font-family: var(--mono); font-size: 11px; height: 240px; overflow-y: auto; }
  .log-line { padding: 1px 0; line-height: 1.7; }
  .log-info { color: var(--text2); }
  .log-ok { color: var(--accent3); }
  .log-warn { color: var(--warn); }
  .log-err { color: var(--danger); }
  .log-accent { color: var(--accent); }
  .log-purple { color: #a78bfa; }

  /* Progress bar */
  .progress-bar { height: 4px; background: var(--surface3); border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); border-radius: 2px; transition: width 0.4s ease; }

  /* Mic button */
  .mic-btn { width: 56px; height: 56px; border-radius: 50%; border: 2px solid var(--border2); background: var(--surface2); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s; position: relative; flex-shrink: 0; }
  .mic-btn:hover { border-color: var(--accent); }
  .mic-btn.listening { border-color: var(--danger); background: rgba(239,68,68,0.1); animation: micPulse 1s infinite; }
  @keyframes micPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); } 50% { box-shadow: 0 0 0 10px rgba(239,68,68,0); } }

  /* Voice waveform */
  .waveform { display: flex; align-items: center; gap: 3px; height: 28px; }
  .wave-bar { width: 3px; background: var(--accent); border-radius: 2px; transition: height 0.1s; }

  /* Test case row states */
  .tc-row-running td { background: rgba(0,229,255,0.03); }
  .tc-row-pass td { background: rgba(16,185,129,0.03); }
  .tc-row-fail td { background: rgba(239,68,68,0.03); }

  /* Tabs */
  .tabs { display: flex; gap: 2px; background: var(--surface2); border-radius: var(--r2); padding: 3px; }
  .tab { padding: 6px 14px; border-radius: 4px; font-size: 12px; font-weight: 700; cursor: pointer; color: var(--text3); transition: all 0.15s; border: none; background: none; font-family: var(--sans); }
  .tab.active { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.3); }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }

  /* Divider */
  .divider { height: 1px; background: var(--border); margin: 16px 0; }

  /* Intent pill */
  .intent-pill { font-family: var(--mono); font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(124,58,237,0.15); color: #a78bfa; white-space: nowrap; }

  /* Session turn */
  .turn-bubble { border-radius: 8px; padding: 10px 14px; font-size: 13px; }
  .turn-user { background: rgba(0,229,255,0.08); border: 1px solid rgba(0,229,255,0.15); color: var(--text); margin-left: 20px; }
  .turn-agent { background: var(--surface2); border: 1px solid var(--border); color: var(--text2); margin-right: 20px; }
  .turn-label { font-size: 10px; color: var(--text3); margin-bottom: 4px; font-family: var(--mono); letter-spacing: 1px; text-transform: uppercase; }

  /* Upload zone */
  .upload-zone { border: 2px dashed var(--border2); border-radius: var(--r); padding: 32px; text-align: center; cursor: pointer; transition: all 0.2s; }
  .upload-zone:hover, .upload-zone.drag { border-color: var(--accent); background: rgba(0,229,255,0.04); }
  .upload-icon { font-size: 32px; margin-bottom: 10px; color: var(--text3); }

  /* Empty state */
  .empty { text-align: center; padding: 48px 24px; color: var(--text3); }
  .empty-icon { font-size: 36px; margin-bottom: 12px; }

  /* Chip */
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 999px; font-size: 11px; background: var(--surface3); border: 1px solid var(--border); color: var(--text2); }

  /* Response viewer */
  .response-box { background: #090b0e; border: 1px solid var(--border); border-radius: var(--r2); padding: 12px; font-family: var(--mono); font-size: 11px; color: var(--accent3); white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow-y: auto; }

  /* Animate in */
  @keyframes fadeSlide { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .spinner { width: 24px; height: 24px; border: 2px solid var(--surface3); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.75s linear infinite; }
  .fade-in { animation: fadeSlide 0.25s ease both; }

  /* Score ring */
  .score-ring { position: relative; width: 80px; height: 80px; flex-shrink: 0; }
  .score-ring svg { transform: rotate(-90deg); }
  .score-ring-val { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-size: 16px; font-weight: 700; }

  /* ── TOAST ── */
  .toast-container { position: fixed; bottom: 24px; right: 24px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
  .toast { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-radius: var(--r); font-size: 13px; font-weight: 500; pointer-events: all; box-shadow: 0 8px 24px rgba(0,0,0,0.5); animation: toastIn 0.3s ease both; }
  .toast-success { background: rgba(16,185,129,0.15); border: 1px solid rgba(16,185,129,0.35); color: var(--accent3); }
  .toast-error { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.35); color: var(--danger); }
  .toast-info { background: rgba(0,229,255,0.1); border: 1px solid rgba(0,229,255,0.25); color: var(--accent); }
  @keyframes toastIn { from { opacity:0; transform: translateY(12px); } to { opacity:1; transform: translateY(0); } }
  .toast-icon { font-size: 16px; }

  /* ── PROJECT MODAL ── */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 1000; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
  .modal { background: var(--surface); border: 1px solid var(--border2); border-radius: var(--r); padding: 28px; width: 480px; max-width: 95vw; box-shadow: 0 24px 48px rgba(0,0,0,0.6); animation: fadeSlide 0.2s ease both; }
  .modal-title { font-size: 15px; font-weight: 700; margin-bottom: 20px; color: var(--text); }
  .modal-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }

  /* ── HISTORY PAGE ── */
  .history-run-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--r); padding: 16px 20px; cursor: pointer; transition: border-color 0.15s; }
  .history-run-card:hover { border-color: var(--border2); }
  .history-run-card.expanded { border-color: rgba(0,229,255,0.2); }
  .history-run-header { display: flex; align-items: center; gap: 12px; }
  .history-run-meta { flex: 1; }
  .history-run-title { font-size: 13px; font-weight: 700; color: var(--text); }
  .history-run-sub { font-size: 11px; color: var(--text3); margin-top: 2px; font-family: var(--mono); }
  .history-run-stats { display: flex; gap: 16px; align-items: center; }
  .history-stat { text-align: right; }
  .history-stat-val { font-family: var(--mono); font-size: 14px; font-weight: 700; }
  .history-stat-label { font-size: 10px; color: var(--text3); }
  .history-expand { transition: transform 0.2s; }
  .history-expand.open { transform: rotate(180deg); }
  .history-detail { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 16px; }

  /* ── PRISM ── */
  .prism-root { display: flex; flex-direction: column; gap: 16px; }
  .prism-config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .prism-config-grid { grid-template-columns: 1fr; } }

  .prism-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 18px 20px; }
  .prism-card-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 14px; }
  .prism-hint { font-size: 10px; color: var(--text3); font-weight: 400; margin-left: 4px; font-family: var(--mono); }
  .prism-icon { color: var(--accent); font-size: 14px; }

  .prism-model-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  @media (max-width: 700px) { .prism-model-grid { grid-template-columns: 1fr; } }

  .prism-run-bar { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .prism-progress-wrap { width: 160px; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
  .prism-progress-bar { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s; }
  @keyframes pulse { 0%,100%{ opacity:1 } 50%{ opacity:.4 } }
  .prism-pulse { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-right: 8px; animation: pulse 1.2s ease infinite; }

  .prism-results { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 20px; }
  .prism-summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; margin-bottom: 4px; }
  .prism-summary-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--r2); padding: 18px; transition: border-color 0.2s; }
  .prism-summary-card:hover { border-color: rgba(255,255,255,0.15); }
  .prism-metric-label { font-size: 10px; color: var(--text3); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.8px; font-family: var(--mono); }
  .prism-metric-rows { display: flex; flex-direction: column; }

  .prism-query-list { display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto; }
  .prism-query-row { display: flex; align-items: center; gap: 6px; }
  .prism-input { background: var(--surface3); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 11px; color: var(--text); font-family: var(--sans); outline: none; width: 100%; }
  .prism-input:focus { border-color: rgba(0,229,255,0.35); }

  .btn-danger { background: rgba(239,68,68,0.15); color: var(--danger); border: 1px solid rgba(239,68,68,0.3); }
  .btn-danger:hover { background: rgba(239,68,68,0.25); }
`;

// ─── Constants ────────────────────────────────────────────────────────────────
const RPC_TYPES = {
  time_request: "Time Request", location_request: "Location Request", perms: "Permissions",
  music: "Music Play", youtube_music: "YouTube Music", navigation: "Navigation",
  call: "Call", sos: "SOS/Emergency", time_based_reminder: "Time Reminder",
  geo_register: "Geo Reminder", cancel_reminder: "Cancel Reminder",
  play_podcast: "Play Podcast", assistant_speak: "Assistant Speak",
};

const MODULES = [
  "Assistant","Time","Weather","Music & Podcasts (Spotify)","Music Playback",
  "Reminders – Time-Based","Call Control","Emergency & SOS Calls","Medical Emergency",
  "Fire Emergency","Police Emergency","RSA (Roadside Assistance)","General Emergency Flow",
  "Navigation","Nearby Places / POI","Navigation (Add Stop / Via)","Trains",
  "Public Transport","Traffic / Area Info","Flights","General Knowledge – Facts",
  "Science & Technology","Current Affairs / News","Entertainment & Culture",
  "Contextual / Follow-up Questions","Integration / IVI Behavior",
  "Vehicle Status – Engine","Vehicle Status – Doors & Locks",
  "Vehicle Status – Headlamps / Lights","Vehicle Status – AC / Climate Control",
  "Vehicle Status – Miscellaneous Sensors","Personal Data – Save Name",
  "Favorites – Songs / Tracks","Favorites – Restaurants / Places",
  "Personal Contacts – Family / Friends","Saved Locations – Work & Home","Saved Data Management",
];

const EXPECTED_INTENTS = [
  "get_assistant_info","get_locale_time","get_time_in_location","get_current_weather",
  "get_past_weather","get_future_weather","rain_forecast","uv_index","weather_alerts",
  "music","youtube_music","play_podcast","call","sos","navigation","time_based_reminder",
  "cancel_reminder","geo_register","track_flight_status","search_flights_by_query",
  "get_live_data","get_vehicle_status","execute_vehicle_command","save_preference",
  "save_relationship","save_location","save_user_profile_name","read_database_info",
  "delete_favorite","general_conversation",
];

const SAMPLE_TCS = [
  { id: "TC_AI_001", module: "Assistant", input: "Who are you?", expectedIntent: "get_assistant_info", flow: "Single Turn", sessionId: "SES_001", turnNo: 1 },
  { id: "TC_WEATH_011", module: "Weather", input: "How is the weather in Chennai?", expectedIntent: "get_current_weather", flow: "Single Turn", sessionId: "SES_011", turnNo: 1 },
  { id: "TC_MUS_024", module: "Music Playback", input: "Play Shape of You by Ed Sheeran.", expectedIntent: "music", flow: "Single Turn", sessionId: "SES_024", turnNo: 1 },
  { id: "TC_NAV_082", module: "Navigation", input: "Navigate to Marina Beach.", expectedIntent: "navigation", flow: "Single Turn", sessionId: "SES_082", turnNo: 1 },
  { id: "TC_EMG_058", module: "Emergency & SOS Calls", input: "Call emergency.", expectedIntent: "sos", flow: "Single Turn", sessionId: "SES_058", turnNo: 1 },
  { id: "TC_TRV_122", module: "Flights", input: "What's the status of flight AI 302?", expectedIntent: "track_flight_status", flow: "Single Turn", sessionId: "SES_122", turnNo: 1 },
  { id: "TC_MUS_034_T1", module: "Music Playback", input: "Play Perfect by Ed Sheeran.", expectedIntent: "music", flow: "Multi-Turn", sessionId: "MULTI_001", turnNo: 1 },
  { id: "TC_MUS_034_T2", module: "Music Playback", input: "Play another song by him.", expectedIntent: "music", flow: "Multi-Turn", sessionId: "MULTI_001", turnNo: 2 },
];

// Default projects
const INITIAL_PROJECTS = [
  { id: "proj_citroen", name: "Stellantis", description: "In-vehicle infotainment testing for Stellantis", brand: "stellantis", config: { ...DEFAULT_CONFIG }, testCases: SAMPLE_TCS },
  { id: "proj_ds", name: "DS Automobiles", description: "DS brand voice assistant regression", brand: "ds", config: { ...DEFAULT_CONFIG, deviceId: "ds-regression-001" }, testCases: [] },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genId() { return Math.random().toString(36).slice(2, 9); }
function ts() { return new Date().toLocaleTimeString(); }

function ScoreRing({ pct, color = "#00e5ff" }) {
  const r = 34, circ = 2 * Math.PI * r, dash = (pct / 100) * circ;
  return (
    <div className="score-ring">
      <svg width={80} height={80}>
        <circle cx={40} cy={40} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={6} />
        <circle cx={40} cy={40} r={r} fill="none" stroke={color} strokeWidth={6}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <div className="score-ring-val" style={{ color }}>{pct}%</div>
    </div>
  );
}

function WaveBar({ active, i }) {
  const h = active ? 8 + Math.random() * 20 : 4;
  return <div className="wave-bar" style={{ height: h, opacity: active ? 1 : 0.3, animationDelay: `${i * 0.08}s` }} />;
}

// ─── Toast Component ──────────────────────────────────────────────────────────
function ToastContainer({ toasts }) {
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span className="toast-icon">{t.type === "success" ? "✓" : t.type === "error" ? "✗" : "ℹ"}</span>
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ─── Project Modal ────────────────────────────────────────────────────────────
function ProjectModal({ project, onSave, onClose }) {
  const isEdit = !!project?.id;
  const [form, setForm] = useState(project || {
    id: "proj_" + genId(), name: "", description: "", brand: "stellantis",
    config: { ...DEFAULT_CONFIG }, testCases: [],
  });
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{isEdit ? "Edit Project" : "New Project"}</div>
        <div className="stack" style={{ gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Project Name</label>
            <input className="form-input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Stellantis" />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input className="form-input" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Short description of this project" />
          </div>
          <div className="form-group">
            <label className="form-label">Brand (X-Brand header)</label>
            <input className="form-input" value={form.brand} onChange={e => setForm(p => ({ ...p, brand: e.target.value }))} placeholder="stellantis" />
          </div>
          <div className="grid-2" style={{ gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Backend URL</label>
              <input className="form-input" value={form.config.backendUrl} onChange={e => setForm(p => ({ ...p, config: { ...p.config, backendUrl: e.target.value } }))} placeholder="http://localhost:9090" />
            </div>
            <div className="form-group">
              <label className="form-label">Device ID</label>
              <input className="form-input" value={form.config.deviceId} onChange={e => setForm(p => ({ ...p, config: { ...p.config, deviceId: e.target.value } }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Model</label>
              <select className="form-select" value={form.config.modelName} onChange={e => setForm(p => ({ ...p, config: { ...p.config, modelName: e.target.value } }))}>
                <option value="gpt-5.4-nano">gpt-5.4-nano (Executor)</option>
                <option value="gpt-4o-mini">gpt-4o-mini</option>
                <option value="gpt-4o">gpt-4o</option>
                <option value="gemini">gemini (requires Gemini API)</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Language</label>
              <select className="form-select" value={form.config.language} onChange={e => setForm(p => ({ ...p, config: { ...p.config, language: e.target.value } }))}>
                {["en","hi","ta","te","kn","ml","gu","mr","bn","pa","ur","zh","ko","ja"].map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { if (form.name.trim()) onSave(form); }} disabled={!form.name.trim()}>
            {isEdit ? "Save Changes" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Project Dropdown ─────────────────────────────────────────────────────────
function ProjectDropdown({ projects, activeId, onSelect, onNew, onEdit }) {
  const [open, setOpen] = useState(false);
  const active = projects.find(p => p.id === activeId);
  const ref = useRef(null);
  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  return (
    <div className="project-selector">
      <div className="project-select-label">Project</div>
      <div className="project-dropdown-wrap" ref={ref}>
        <button className="project-dropdown-btn" onClick={() => setOpen(o => !o)}>
          <span>{active?.name || "Select project"}</span>
          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
            <path d="M2 4l4 4 4-4" />
          </svg>
        </button>
        {open && (
          <div className="project-dropdown-menu">
            {projects.map(p => (
              <div key={p.id} className={`project-dropdown-item ${p.id === activeId ? "selected" : ""}`}
                onClick={() => { onSelect(p.id); setOpen(false); }}>
                <span>{p.name}</span>
                <span style={{ display: "flex", gap: 6 }}>
                  {p.id === activeId && <span style={{ fontSize: 10, color: "var(--accent)", fontFamily: "var(--mono)" }}>active</span>}
                  <span style={{ fontSize: 11, color: "var(--text3)", cursor: "pointer", padding: "0 4px" }}
                    onClick={e => { e.stopPropagation(); onEdit(p); setOpen(false); }}>✎</span>
                </span>
              </div>
            ))}
            <div className="project-dropdown-divider" />
            <div className="project-dropdown-add" onClick={() => { onNew(); setOpen(false); }}>
              <span>＋</span> New Project
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [projects, setProjects] = useState(INITIAL_PROJECTS);
  const [activeProjectId, setActiveProjectId] = useState(INITIAL_PROJECTS[0].id);
  const [projectModal, setProjectModal] = useState(null); // null | "new" | {project}
  const [page, setPage] = useState("run");
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(false);
  const [currentTcId, setCurrentTcId] = useState(null);
  const [logs, setLogs] = useState([
    { level: "info", msg: "AURA — Autonomous Unified Regression Assistant · Ready" },
    { level: "accent", msg: "Multi-project support enabled" },
    { level: "info", msg: "Upload your Excel test cases or use the sample set to begin." },
  ]);
  const [voiceInput, setVoiceInput] = useState("");
  const [singleResult, setSingleResult] = useState(null);
  const [singleRunning, setSingleRunning] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [waveActive, setWaveActive] = useState(false);
  const [activeTab, setActiveTab] = useState("text");
  const [runProgress, setRunProgress] = useState(0);
  const [reportData, setReportData] = useState(null);
  const [newTc, setNewTc] = useState({ id: "", module: MODULES[0], input: "", expectedIntent: "general_conversation", sessionId: "", turnNo: 1, flow: "Single Turn" });
  const [toasts, setToasts] = useState([]);
  const [history, setHistory] = useState([]); // [{id, projectId, projectName, runAt, pass, fail, total, passPct, results, testCases}]
  const [expandedHistory, setExpandedHistory] = useState(null);
  // Test Cases sub-tabs: "manage" | "prd"
  const [casesSubTab, setCasesSubTab] = useState("manage");
  // Requirement document uploaded from Test Cases page
  const [requirementDoc, setRequirementDoc] = useState(null); // null | {name, text, size, wordCount}
  const [reqDocUploading, setReqDocUploading] = useState(false);
  // Judge LLM evaluation results (replaces old per-TC results table on Run page)
  const [judgeReport, setJudgeReport] = useState(null); // null | {rows, summary, meta, allure, download}
  // Streaming run progress
  const [runProgressLog, setRunProgressLog] = useState([]); // [{tc_id, status, consolidated_percentage, done, total, ...}]
  const [runPhase, setRunPhase] = useState("idle");          // "idle" | "submitting" | "processing" | "reporting"
  const [runStartTime, setRunStartTime] = useState(null);
  const [elapsedSecs, setElapsedSecs] = useState(0);

  const logRef = useRef(null);
  const recognitionRef = useRef(null);

  // Active project helpers
  const activeProject = projects.find(p => p.id === activeProjectId) || projects[0];
  const config = activeProject.config;
  const testCases = activeProject.testCases;

  function setTestCases(fn) {
    setProjects(prev => prev.map(p => p.id === activeProjectId
      ? { ...p, testCases: typeof fn === "function" ? fn(p.testCases) : fn }
      : p));
  }
  function setConfig(fn) {
    setProjects(prev => prev.map(p => p.id === activeProjectId
      ? { ...p, config: typeof fn === "function" ? fn(p.config) : fn }
      : p));
  }

  // Reset run state when switching projects
  useEffect(() => {
    setResults({});
    setReportData(null);
    setLogs([
      { level: "info", msg: `Switched to project: ${activeProject?.name}` },
      { level: "accent", msg: `Backend: ${activeProject?.config?.backendUrl}` },
    ]);
    setRunProgress(0);
    setCurrentTcId(null);
  }, [activeProjectId]);

  // Toast helper
  const showToast = useCallback((message, type = "success") => {
    const id = genId();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  const addLog = useCallback((level, msg) => {
    setLogs(prev => [...prev.slice(-200), { level, msg: `[${ts()}] ${msg}` }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // Tick elapsed timer while a run is in progress
  useEffect(() => {
    if (!running || !runStartTime) return;
    const id = setInterval(() => setElapsedSecs(Math.floor((Date.now() - runStartTime) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running, runStartTime]);

  // ── API Calls ──────────────────────────────────────────────────────────────
  async function callProcessText(text, sessionDeviceId, testCase = null) {
    return processText({
      config,
      brand: activeProject.brand,
      text,
      deviceId: sessionDeviceId || config.deviceId,
      testCase,
    });
  }

  async function callProcessTestCase(testCase, sessionDeviceId) {
    return processTextTurns({
      config,
      brand: activeProject.brand,
      deviceId: sessionDeviceId,
      testCase,
    });
  }

  // ── Single Test Run ─────────────────────────────────────────────────────────
  async function runSingle() {
    if (!voiceInput.trim()) return;
    setSingleRunning(true); setSingleResult(null);
    addLog("accent", `Running single test: "${voiceInput}"`);
    try {
      const data = await callProcessText(voiceInput, config.deviceId + "-single");
      setSingleResult({ input: voiceInput, data, ts: new Date().toLocaleTimeString() });
      addLog("ok", `Response intent: ${data.intent || data.type || "general_conversation"}`);
      addLog("ok", `Message: ${data.assistant?.message?.slice(0, 80) || "(no message)"}…`);
    } catch (e) {
      addLog("err", `Single test failed: ${e.message}`);
      setSingleResult({ input: voiceInput, error: e.message, ts: new Date().toLocaleTimeString() });
    }
    setSingleRunning(false);
  }

  // ── Elapsed time formatter ────────────────────────────────────────────────────
  function fmtElapsed(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  // ── Full Regression Run — Judge LLM Pipeline (SSE streaming) ─────────────────
  async function runRegression() {
    if (running || testCases.length === 0) return;

    if (!requirementDoc) {
      addLog("warn", "No Requirement Document — Judge LLM will use original expected results only.");
    }

    setRunning(true);
    setRunProgress(0);
    setJudgeReport(null);
    setRunProgressLog([]);
    setRunPhase("submitting");
    setRunStartTime(Date.now());
    setElapsedSecs(0);

    addLog("accent", `▶ Starting Judge LLM evaluation — ${testCases.length} test cases`);
    addLog("info", `LLM 1 (Executor, gpt-5.4-nano) + LLM 2 (Judge, gpt-5.4-mini) in parallel`);
    if (requirementDoc) addLog("info", `Requirement doc: "${requirementDoc.name}" (${requirementDoc.wordCount} words)`);
    addLog("info", `CARA backend: ${config.backendUrl} | Language: ${config.language}`);

    const cases = testCases.map(tc => ({
      id: tc.id, input: tc.input,
      expectedIntent: tc.expectedIntent, expectedResponse: tc.expectedResponse || "",
      module: tc.module, sessionId: tc.sessionId, flow: tc.flow,
      language: config.language, timezone: config.timezone,
      latitude: config.latitude, longitude: config.longitude,
      pipeline: config.pipeline, vehicleBackend: config.vehicleBackend,
      vehicleVin: config.vehicleVin, regressionVehicleToken: config.regressionVehicleToken,
    }));

    try {
      const resp = await fetch(`${QA_RUNNER_BASE}/judge/run-evaluation-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCases: cases,
          caraBaseUrl: config.backendUrl,
          brand: activeProject.brand,
          deviceId: config.deviceId,
          withExecutor: true,
          requirementDocText: requirementDoc?.text || "",
          reportFormat: "html",
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.detail || `HTTP ${resp.status}`);
      }

      setRunPhase("processing");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const parts = buf.split("\n\n");
        buf = parts.pop();

        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          let evt;
          try { evt = JSON.parse(part.slice(6)); } catch { continue; }

          if (evt.type === "start") {
            addLog("accent", `▶ Pipeline started — ${evt.total} test cases queued`);

          } else if (evt.type === "progress") {
            setRunProgress(Math.round((evt.done / evt.total) * 100));
            setRunProgressLog(prev => [evt, ...prev]);
            const lvl = evt.status === "Pass" ? "ok" : evt.status === "Fail" ? "err" : "warn";
            addLog(lvl, `[${evt.done}/${evt.total}] ${evt.tc_id} — ${evt.status} (${evt.consolidated_percentage}%)`);

          } else if (evt.type === "phase") {
            setRunPhase("reporting");
            addLog("info", evt.message);

          } else if (evt.type === "complete") {
            const data = evt.payload;
            setJudgeReport(data);
            setRunProgress(100);
            setRunPhase("done");
            const s = data.summary || {};
            const passPct = s.total > 0 ? Math.round((s.pass / s.total) * 100) : 0;
            addLog("accent", `▶ Done: ${s.pass} Pass, ${s.partial ?? 0} Partial, ${s.fail} Fail / ${s.total} total`);
            addLog("info", `Avg Accuracy: ${s.avg_accuracy ?? "—"} | Intent: ${s.avg_intent ?? "—"} | Efficiency: ${s.avg_efficiency ?? "—"} | Consolidated: ${s.avg_consolidated_percentage ?? "—"}%`);
            showToast(`Evaluation complete — ${s.pass}/${s.total} Pass (${passPct}%)`, passPct >= 80 ? "success" : "error");
            setHistory(prev => [{
              id: "run_" + genId(), projectId: activeProjectId, projectName: activeProject.name,
              runAt: new Date().toLocaleString(),
              pass: s.pass, partial: s.partial ?? 0, fail: s.fail, total: s.total, passPct,
              results: {}, judgeRows: data.rows, testCases: [...testCases],
            }, ...prev]);

          } else if (evt.type === "error") {
            throw new Error(evt.message);
          }
        }
      }
    } catch (e) {
      addLog("err", `Evaluation failed: ${e.message}`);
      showToast(`Evaluation failed: ${e.message}`, "error");
    } finally {
      setRunning(false);
      setRunPhase("idle");
      setCurrentTcId(null);
    }
  }

  // ── Voice Input ─────────────────────────────────────────────────────────────
  function startListening() {
    if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
      addLog("warn", "Speech recognition not available in this browser.");
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = false; rec.interimResults = true; rec.lang = "en-US";
    rec.onstart = () => { setIsListening(true); setWaveActive(true); };
    rec.onresult = (e) => setVoiceInput(Array.from(e.results).map(r => r[0].transcript).join(""));
    rec.onend = () => { setIsListening(false); setWaveActive(false); };
    rec.start();
    recognitionRef.current = rec;
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setIsListening(false); setWaveActive(false);
  }

  // ── File Upload ─────────────────────────────────────────────────────────────
  async function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // allow re-uploading same file

    addLog("info", `Reading file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
    showToast("Parsing file…", "info");

    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parseExcelBuffer(buffer, file.name);

      setTestCases(() => parsed);
      addLog("ok", `✓ Loaded ${parsed.length} test cases from "${file.name}"`);

      // Log a brief column summary from the first row
      const sample = parsed[0];
      addLog("info", `  Sample — ID: ${sample.id} | Session: ${sample.sessionId} | Turn: ${sample.turnNo} | Module: ${sample.module} | Flow: ${sample.flow} | Intent: ${sample.expectedIntent}`);
      addLog("info", `  Columns parsed: id, sessionId, turnNo, module, flow, input, expectedIntent, expectedResponse, testCategory, testType`);

      showToast(`File Uploaded Successfully — ${parsed.length} test cases loaded`, "success");
    } catch (err) {
      addLog("err", `Upload failed: ${err.message}`);
      showToast(`Upload failed: ${err.message}`, "error");
    }
  }

  // ── Requirement Document Upload ─────────────────────────────────────────────
  async function handleRequirementDocUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const ext = file.name.split(".").pop().toLowerCase();
    if (!["pdf", "docx", "txt"].includes(ext)) {
      showToast("Unsupported file type. Upload a PDF, DOCX, or TXT file.", "error");
      return;
    }

    setReqDocUploading(true);
    addLog("info", `Parsing requirement document: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
    showToast("Parsing requirement document…", "info");

    try {
      const formData = new FormData();
      formData.append("file", file);
      const resp = await fetch(`${QA_RUNNER_BASE}/judge/parse-requirement-doc`, {
        method: "POST",
        body: formData,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      setRequirementDoc({ name: data.name, text: data.text, size: data.size, wordCount: data.word_count });
      addLog("ok", `✓ Requirement document loaded: "${data.name}" — ${data.word_count} words`);
      showToast(`Requirement document loaded — ${data.word_count} words`, "success");
    } catch (err) {
      addLog("err", `Requirement document upload failed: ${err.message}`);
      showToast(`Upload failed: ${err.message}`, "error");
    } finally {
      setReqDocUploading(false);
    }
  }

  // ── Export Report ───────────────────────────────────────────────────────────
  function exportReport(rd, tcs, format = "html") {
    if (!rd) return;
    const useTcs = tcs || testCases;

    if (format === "html") {
      // Allure-style HTML report
      downloadAllureReport({
        reportData: {
          results:  rd.results || {},
          total:    rd.total   || useTcs.length,
          pass:     rd.pass    || Object.values(rd.results || {}).filter(r => r.pass).length,
          fail:     rd.fail    || Object.values(rd.results || {}).filter(r => !r.pass).length,
          runAt:    rd.runAt   || new Date().toISOString(),
        },
        testCases: useTcs,
        projectName: activeProject?.name || "AURA",
      });
      addLog("ok", "Allure-style HTML report downloaded");
      showToast("HTML report downloaded", "success");
      return;
    }

    // CSV fallback
    const rows = [
      ["Test Case ID","Module","Input","Expected Intent","Actual Intent","Pass/Fail","Confidence","Match Source","Expected Tool","Expected Handler","Actual Tool","Tool Routing OK","Routing Warning","Intent→Tool→Handler Chain","Response","Error"],
      ...useTcs.map(tc => {
        const r   = rd.results[tc.id] || {};
        const tc_ = r.toolCheck || {};
        const ic  = r.intentChain || {};
        return [
          tc.id, tc.module, tc.input, tc.expectedIntent,
          r.actualIntent || "",
          r.pass ? "PASS" : "FAIL",
          r.confidence || 0,
          r.matchSource || "",
          tc_.expectedTool || ic.tool || "",
          ic.handler || "",
          tc_.actualTool || "",
          tc_.isCorrect === false ? "NO" : "YES",
          tc_.warning || "",
          ic.chain || "",
          r.message || "", r.error || "",
        ];
      })
    ];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `AURA_Report_${(activeProject?.name || "AURA").replace(/\s+/g, "_")}_${Date.now()}.csv`;
    a.click();
    addLog("ok", "Report exported as CSV");
    showToast("CSV report downloaded", "success");
  }

  // ── Project management ──────────────────────────────────────────────────────
  function saveProject(form) {
    setProjects(prev => {
      const exists = prev.find(p => p.id === form.id);
      if (exists) return prev.map(p => p.id === form.id ? form : p);
      return [...prev, form];
    });
    if (!projects.find(p => p.id === form.id)) setActiveProjectId(form.id);
    setProjectModal(null);
    showToast(form.name + " saved", "success");
  }

  // ─── Render ──────────────────────────────────────────────────────────────────
  const totalPass = judgeReport?.summary?.pass ?? 0;
  const totalFail = judgeReport?.summary?.fail ?? 0;
  const totalRun = judgeReport?.summary?.total ?? 0;

  const navItems = [
    { id: "run",      label: "Run Tests" },
    { id: "single",   label: "Single Voice Test" },
    { id: "voice-e2e",label: "Voice E2E" },
    { id: "prism",    label: "PRISM",  badge: "NEW", badgeColor: "var(--accent)" },
    { id: "vectora",  label: "VECTORA", badge: "RAG", badgeColor: "var(--accent2)" },
    { id: "cases",    label: "Test Cases" },
    { id: "config",   label: "Configuration" },
    { id: "report",   label: "Report" },
    { id: "history",  label: "History" },
  ];

  return (
    <>
      <style>{CSS}</style>
      <ToastContainer toasts={toasts} />

      {projectModal && (
        <ProjectModal
          project={projectModal === "new" ? null : projectModal}
          onSave={saveProject}
          onClose={() => setProjectModal(null)}
        />
      )}

      <div className="app">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sidebar-logo">
            <div className="logo-mark">AURA</div>
            <div className="logo-sub">Autonomous Unified Regression Assistant</div>
          </div>

          {/* Project selector */}
          <ProjectDropdown
            projects={projects}
            activeId={activeProjectId}
            onSelect={id => setActiveProjectId(id)}
            onNew={() => setProjectModal("new")}
            onEdit={p => setProjectModal(p)}
          />

          <div className="sidebar-section">
            <div className="sidebar-section-label">Navigation</div>
            {navItems.map(n => (
              <div key={n.id} className={`nav-item ${page === n.id ? "active" : ""}`} onClick={() => setPage(n.id)}>
                <div className="nav-dot" />
                {n.label}
                {n.badge && (
                  <span style={{ marginLeft: "auto", fontSize: 8, fontFamily: "var(--mono)", fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: `${n.badgeColor}22`, color: n.badgeColor, border: `1px solid ${n.badgeColor}44` }}>{n.badge}</span>
                )}
                {n.id === "history" && history.length > 0 && (
                  <span className="badge badge-idle" style={{ marginLeft: n.badge ? 4 : "auto", fontSize: 9 }}>{history.length}</span>
                )}
              </div>
            ))}
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-label">Live Stats</div>
            <div className="stack" style={{ gap: 6 }}>
              <div className="card-sm">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--text3)", fontFamily: "var(--mono)" }}>Total TCs</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--accent)" }}>{testCases.length}</span>
                </div>
              </div>
              <div className="card-sm">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--text3)", fontFamily: "var(--mono)" }}>Pass</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--accent3)" }}>{totalPass}</span>
                </div>
              </div>
              <div className="card-sm">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--text3)", fontFamily: "var(--mono)" }}>Fail</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--danger)" }}>{totalFail}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="sidebar-footer">
            <div className="config-badge">
              <div className="status-dot" />
              <span>{config.backendUrl.replace("http://","").replace("https://","")}</span>
            </div>
            <div className="config-badge" style={{ marginTop: 6 }}>
              <span style={{ color: "var(--accent2)" }}>◈</span>
              <span>{activeProject.name}</span>
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="main">
          {/* Topbar */}
          <div className="topbar">
            <div>
              <div className="page-title">
                {page === "run"      && "Regression Run"}
                {page === "single"   && "Single Voice Test"}
                {page === "voice-e2e"&& "Voice E2E (LiveKit)"}
                {page === "prism"    && <span>PRISM <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text3)", fontFamily: "var(--mono)" }}>Multi-Model Benchmark</span></span>}
                {page === "vectora"  && <span>VECTORA <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text3)", fontFamily: "var(--mono)" }}>Vector Embedding &amp; Retrieval</span></span>}
                {page === "cases"    && (casesSubTab === "prd" ? <span>Test Cases <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text3)", fontFamily: "var(--mono)" }}>PRD Analyzer</span></span> : "Test Cases")}
                {page === "config"   && "Configuration"}
                {page === "report"   && "Test Report"}
                {page === "history"  && "Run History"}
              </div>
              <div className="page-sub">{activeProject.name} · AURA</div>
            </div>
            <div className="topbar-actions">
              {page === "run" && (
                <>
                  <button className="btn btn-primary" onClick={runRegression} disabled={running || testCases.length === 0}>
                    {running ? "Evaluating…" : "▶ Run Tests"}
                  </button>
                  {judgeReport && (
                    <>
                      <button className="btn btn-secondary" onClick={() => downloadJudgeAllureReport({ allure: judgeReport.allure, summary: judgeReport.summary, meta: judgeReport.meta, projectName: activeProject?.name || "AURA" })}>
                        ↓ Allure HTML
                      </button>
                      <button className="btn btn-secondary" onClick={() => {
                        const dl = judgeReport.download;
                        if (dl?.content) {
                          const blob = new Blob([dl.content], { type: dl.mime || "text/html" });
                          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = dl.filename || "judge-report.html"; a.click(); URL.revokeObjectURL(a.href);
                        }
                      }}>↓ HTML Report</button>
                    </>
                  )}
                </>
              )}
              {page === "report" && reportData && (
                <div style={{ display:"flex", gap:6 }}>
                  <button className="btn btn-success" onClick={() => exportReport(reportData, null, "html")} title="Download Allure-style HTML report">↓ HTML Report</button>
                  <button className="btn btn-outline" style={{ fontSize:11, padding:"4px 10px" }} onClick={() => exportReport(reportData, null, "csv")} title="Download raw CSV">↓ CSV</button>
                </div>
              )}
              {page === "cases" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <div className="tabs">
                    <button className={`tab ${casesSubTab === "manage" ? "active" : ""}`} onClick={() => setCasesSubTab("manage")}>
                      Manage
                    </button>
                    <button className={`tab ${casesSubTab === "prd" ? "active" : ""}`} onClick={() => setCasesSubTab("prd")}
                      style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      PRD Analyzer
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(16,185,129,0.2)", color: "var(--accent3)", border: "1px solid rgba(16,185,129,0.3)" }}>AI</span>
                    </button>
                  </div>
                  {casesSubTab === "manage" && (
                    <button className="btn btn-primary" onClick={() => {
                      if (!newTc.id || !newTc.input) return;
                      setTestCases(prev => [...prev, { ...newTc, id: newTc.id || genId() }]);
                      setNewTc({ id: "", module: MODULES[0], input: "", expectedIntent: "general_conversation", sessionId: "", turnNo: 1, flow: "Single Turn" });
                      addLog("ok", `Added test case ${newTc.id}`);
                      showToast(`Test case ${newTc.id} added`, "success");
                    }}>+ Add Test Case</button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="content">

            {/* ── RUN PAGE ──────────────────────────────────────────────── */}
            {page === "run" && (() => {
              const s = judgeReport?.summary;
              const rows = judgeReport?.rows || [];
              return (
              <div className="stack fade-in" style={{ gap: 20 }}>

                {/* Upload status banner */}
                {(!testCases.length || !requirementDoc) && (
                  <div className="card" style={{ borderColor: !testCases.length ? "rgba(239,68,68,0.4)" : "rgba(245,158,11,0.35)", background: !testCases.length ? "rgba(239,68,68,0.04)" : "rgba(245,158,11,0.04)" }}>
                    <div className="card-title" style={{ color: !testCases.length ? "var(--danger)" : "var(--warn)", marginBottom: 10 }}>
                      {!testCases.length ? "No Test Cases Loaded" : "Optional Upload Missing"}
                    </div>
                    <div className="stack" style={{ gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                        <span style={{ fontSize: 16 }}>{testCases.length ? "✓" : "✗"}</span>
                        <span style={{ color: testCases.length ? "var(--accent3)" : "var(--danger)" }}>
                          Test Cases — {testCases.length ? `${testCases.length} loaded` : "None — upload a file or add them manually on the Test Cases tab"}
                        </span>
                      </div>
                      {!requirementDoc && (
                        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                          <span style={{ fontSize: 16, color: "var(--warn)" }}>○</span>
                          <span style={{ color: "var(--text3)" }}>
                            Requirement Document — not uploaded (optional, improves Judge LLM accuracy)
                          </span>
                        </div>
                      )}
                    </div>
                    {!testCases.length && (
                      <button className="btn btn-secondary" style={{ marginTop: 12, fontSize: 11 }} onClick={() => setPage("cases")}>
                        → Go to Test Cases
                      </button>
                    )}
                  </div>
                )}

                {/* Summary stat cards */}
                <div className="grid-4">
                  <div className="stat"><div className="stat-val">{s ? s.total : testCases.length}</div><div className="stat-label">Total Test Cases</div></div>
                  <div className="stat green"><div className="stat-val">{s?.pass ?? 0}</div><div className="stat-label">Pass</div></div>
                  <div className="stat warn"><div className="stat-val">{s?.partial ?? 0}</div><div className="stat-label">Partial</div></div>
                  <div className="stat red"><div className="stat-val">{s?.fail ?? 0}</div><div className="stat-label">Fail</div></div>
                </div>

                {/* ── Live Execution Progress ── */}
                {running && (
                  <div className="card" style={{ borderColor: "rgba(0,229,255,0.25)", background: "rgba(0,229,255,0.02)" }}>
                    {/* Header row */}
                    <div className="row-between" style={{ marginBottom: 12 }}>
                      <div>
                        <div className="card-title" style={{ color: "var(--accent)" }}>
                          Judge LLM Evaluation in Progress
                        </div>
                        <div className="card-sub" style={{ fontFamily: "var(--mono)", marginTop: 3 }}>
                          {runPhase === "submitting" && "Submitting to Judge pipeline…"}
                          {runPhase === "processing" && `Processing test cases — ${runProgressLog.length} / ${testCases.length} complete`}
                          {runPhase === "reporting" && "Generating report…"}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text3)" }}>
                          {fmtElapsed(elapsedSecs)}
                        </span>
                        <span className="badge badge-run">{runProgress}%</span>
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div className="progress-bar" style={{ marginBottom: 14 }}>
                      <div className="progress-fill" style={{ width: `${runProgress}%` }} />
                    </div>

                    {/* Stage chips */}
                    <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                      {[
                        { key: "submitting", label: "1 · Submitting" },
                        { key: "processing", label: "2 · Evaluating TCs" },
                        { key: "reporting",  label: "3 · Generating Report" },
                      ].map(stage => {
                        const isActive = runPhase === stage.key;
                        const isDone = (
                          (stage.key === "submitting" && ["processing","reporting","done"].includes(runPhase)) ||
                          (stage.key === "processing" && ["reporting","done"].includes(runPhase))
                        );
                        return (
                          <span key={stage.key} style={{
                            padding: "3px 10px", borderRadius: 999, fontSize: 11, fontFamily: "var(--mono)",
                            background: isActive ? "rgba(0,229,255,0.15)" : isDone ? "rgba(16,185,129,0.12)" : "var(--surface3)",
                            color: isActive ? "var(--accent)" : isDone ? "var(--accent3)" : "var(--text3)",
                            border: `1px solid ${isActive ? "rgba(0,229,255,0.3)" : isDone ? "rgba(16,185,129,0.25)" : "transparent"}`,
                            fontWeight: isActive ? 700 : 400,
                          }}>
                            {isDone ? "✓ " : isActive ? "⟳ " : ""}{stage.label}
                          </span>
                        );
                      })}
                    </div>

                    {/* Live per-TC feed */}
                    {runProgressLog.length > 0 && (
                      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                        <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
                          Completed test cases (newest first)
                        </div>
                        <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                          {runProgressLog.map((evt, i) => {
                            const badgeCls = evt.status === "Pass" ? "badge-pass" : evt.status === "Partial" ? "badge-partial" : "badge-fail";
                            const scoreColor = evt.consolidated_percentage >= 80 ? "var(--accent3)" : evt.consolidated_percentage >= 50 ? "var(--warn)" : "var(--danger)";
                            return (
                              <div key={i} style={{
                                display: "flex", alignItems: "center", gap: 10, fontSize: 11,
                                padding: "5px 8px", borderRadius: 6,
                                background: i === 0 ? "rgba(0,229,255,0.05)" : "transparent",
                                border: i === 0 ? "1px solid rgba(0,229,255,0.1)" : "1px solid transparent",
                              }}>
                                <span className={`badge ${badgeCls}`} style={{ flexShrink: 0 }}>{evt.status}</span>
                                <span style={{ fontFamily: "var(--mono)", color: "var(--text)", minWidth: 120, flexShrink: 0 }}>{evt.tc_id}</span>
                                <span style={{ color: "var(--text3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {evt.test_scenario}
                                </span>
                                <span style={{ fontFamily: "var(--mono)", fontWeight: 700, color: scoreColor, flexShrink: 0 }}>
                                  {evt.consolidated_percentage}%
                                </span>
                                <span style={{ color: "var(--text3)", fontSize: 10, flexShrink: 0, fontFamily: "var(--mono)" }}>
                                  {evt.done}/{evt.total}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Waiting state before first TC completes */}
                    {runProgressLog.length === 0 && runPhase === "processing" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text3)", padding: "8px 0" }}>
                        <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                        LLM 1 + LLM 2 running in parallel — waiting for first result…
                      </div>
                    )}
                  </div>
                )}

                {/* Judge score averages (shown after run) */}
                {s && (
                  <div className="grid-4">
                    <div className="stat accent"><div className="stat-val">{s.avg_accuracy ?? "—"}</div><div className="stat-label">Avg Accuracy</div></div>
                    <div className="stat accent"><div className="stat-val">{s.avg_intent ?? "—"}</div><div className="stat-label">Avg Intent</div></div>
                    <div className="stat accent"><div className="stat-val">{s.avg_efficiency ?? "—"}</div><div className="stat-label">Avg Efficiency</div></div>
                    <div className="stat accent"><div className="stat-val">{s.avg_consolidated_percentage ?? "—"}%</div><div className="stat-label">Avg Consolidated</div></div>
                  </div>
                )}

                {/* Results table — 9 judge columns */}
                <div className="card">
                  <div className="card-header">
                    <div>
                      <div className="card-title">Evaluation Results</div>
                      <div className="card-sub">{rows.length > 0 ? `${rows.length} test cases evaluated` : judgeReport ? "No results" : "Run the evaluation to see results"}</div>
                    </div>
                  </div>
                  {rows.length > 0 ? (
                    <div className="table-wrap" style={{ overflowX: "auto" }}>
                      <table>
                        <thead>
                          <tr>
                            <th>#</th>
                            <th style={{ minWidth: 180 }}>Test Scenario</th>
                            <th style={{ minWidth: 180 }}>Expected Result</th>
                            <th style={{ minWidth: 200 }}>Newly Generated Expected</th>
                            <th style={{ minWidth: 220 }}>Judgement</th>
                            <th style={{ minWidth: 200 }}>Actual Result</th>
                            <th style={{ minWidth: 70 }}>Accuracy</th>
                            <th style={{ minWidth: 70 }}>Intent</th>
                            <th style={{ minWidth: 70 }}>Efficiency</th>
                            <th>Status</th>
                            <th style={{ minWidth: 100 }}>Consolidated %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, i) => {
                            const statusCls = row.status === "Pass" ? "badge-pass" : row.status === "Partial" ? "badge-partial" : "badge-fail";
                            const reasoning = row.enhancement_reasoning || row.enhancement?.reasoning || "";
                            const scoreColor = (v) => v >= 80 ? "var(--accent3)" : v >= 50 ? "var(--warn)" : "var(--danger)";
                            return (
                              <tr key={row.tc_id || i}>
                                <td className="td-mono" style={{ color: "var(--text3)", verticalAlign: "top" }}>{i + 1}</td>
                                <td style={{ maxWidth: 200, fontSize: 11, whiteSpace: "pre-wrap", verticalAlign: "top" }}>{row.test_scenario}</td>
                                <td style={{ maxWidth: 180, fontSize: 11, whiteSpace: "pre-wrap", verticalAlign: "top", color: "var(--text3)" }}>{row.expected_result}</td>
                                <td style={{ maxWidth: 200, fontSize: 11, whiteSpace: "pre-wrap", verticalAlign: "top", color: "var(--accent)" }}>{row.newly_generated_expected_result}</td>
                                <td style={{ maxWidth: 220, fontSize: 11, whiteSpace: "pre-wrap", verticalAlign: "top", color: "var(--warn)", fontStyle: reasoning ? "normal" : "italic" }}>
                                  {reasoning || "—"}
                                </td>
                                <td style={{ maxWidth: 200, fontSize: 11, whiteSpace: "pre-wrap", verticalAlign: "top" }}>{row.actual_result}</td>
                                <td className="td-mono" style={{ verticalAlign: "top", color: scoreColor(row.accuracy) }}>{row.accuracy}</td>
                                <td className="td-mono" style={{ verticalAlign: "top", color: scoreColor(row.intent) }}>{row.intent}</td>
                                <td className="td-mono" style={{ verticalAlign: "top", color: scoreColor(row.efficiency) }}>{row.efficiency}</td>
                                <td style={{ verticalAlign: "top" }}><span className={`badge ${statusCls}`}>{row.status}</span></td>
                                <td className="td-mono" style={{ fontWeight: 700, verticalAlign: "top" }}>{row.consolidated_percentage}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="empty" style={{ padding: "32px 24px" }}>
                      <div className="empty-icon">⚖</div>
                      <div style={{ fontSize: 13, marginBottom: 6 }}>No results yet</div>
                      <div style={{ fontSize: 11, color: "var(--text3)" }}>Upload test cases + requirement document, then click Run Tests</div>
                    </div>
                  )}
                </div>

                <div className="card">
                  <div className="card-header">
                    <div className="card-title">Execution Log</div>
                    <button className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => setLogs([])}>Clear</button>
                  </div>
                  <div className="terminal" ref={logRef}>
                    {logs.map((l, i) => <div key={i} className={`log-line log-${l.level}`}>{l.msg}</div>)}
                  </div>
                </div>
              </div>
            );
            })()}

            {/* ── SINGLE TEST PAGE ──────────────────────────────────────── */}
            {page === "voice-e2e" && (
              <VoiceE2EPanel
                backendUrl={config.backendUrl}
                addLog={addLog}
                showToast={showToast}
              />
            )}

            {page === "prism" && (
              <div className="fade-in">
                <PrismPanel config={config} />
              </div>
            )}

            {page === "vectora" && (
              <div className="fade-in">
                <VectoraPanel showToast={showToast} />
              </div>
            )}

            {page === "single" && (
              <div className="stack fade-in" style={{ gap: 20 }}>
                <div className="card">
                  <div className="card-header">
                    <div>
                      <div className="card-title">Single Voice Command Test</div>
                      <div className="card-sub">Type or speak a prompt — CARA processes it via POST /api/v1/process-text</div>
                    </div>
                    <div className="tabs">
                      <button className={`tab ${activeTab === "text" ? "active" : ""}`} onClick={() => setActiveTab("text")}>Type</button>
                      <button className={`tab ${activeTab === "voice" ? "active" : ""}`} onClick={() => setActiveTab("voice")}>Speak</button>
                    </div>
                  </div>
                  {activeTab === "text" ? (
                    <div className="stack">
                      <div className="form-group">
                        <label className="form-label">Voice Prompt</label>
                        <div style={{ display: "flex", gap: 10 }}>
                          <input className="form-input" value={voiceInput} onChange={e => setVoiceInput(e.target.value)}
                            placeholder='e.g. "Navigate to Marina Beach"'
                            onKeyDown={e => e.key === "Enter" && runSingle()} />
                          <button className="btn btn-primary" onClick={runSingle} disabled={singleRunning || !voiceInput.trim()}>{singleRunning ? "Running…" : "▶ Test"}</button>
                        </div>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {["Who are you?","How is the weather in Chennai?","Play Shape of You by Ed Sheeran.","Navigate to Marina Beach.","Call emergency.","Remind me to drink water at 4 PM."].map(s => (
                          <button key={s} className="chip" style={{ cursor: "pointer", fontSize: 11 }} onClick={() => setVoiceInput(s)}>{s}</button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="stack" style={{ alignItems: "center", padding: "20px 0" }}>
                      <div className="waveform">{Array.from({ length: 12 }).map((_, i) => <WaveBar key={i} active={waveActive} i={i} />)}</div>
                      <button className={`mic-btn ${isListening ? "listening" : ""}`} onClick={isListening ? stopListening : startListening}>
                        <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
                        </svg>
                      </button>
                      <div style={{ fontSize: 12, color: "var(--text3)" }}>{isListening ? "Listening… tap to stop" : "Tap to speak"}</div>
                      {voiceInput && (
                        <div style={{ background: "var(--surface2)", borderRadius: "var(--r2)", padding: "10px 16px", fontFamily: "var(--mono)", fontSize: 12, color: "var(--accent)", maxWidth: 400, textAlign: "center" }}>"{voiceInput}"</div>
                      )}
                      {voiceInput && <button className="btn btn-primary" onClick={runSingle} disabled={singleRunning}>{singleRunning ? "Testing…" : "▶ Test This Prompt"}</button>}
                    </div>
                  )}
                </div>

                {singleResult && (
                  <div className="card fade-in">
                    <div className="card-header">
                      <div className="card-title">Result — {singleResult.ts}</div>
                      {singleResult.error ? <span className="badge badge-fail">ERROR</span> :
                        <span className={`badge ${singleResult.data?.intent === "general_conversation" ? "badge-partial" : "badge-pass"}`}>{singleResult.data?.intent || "general_conversation"}</span>}
                    </div>
                    {singleResult.error ? (
                      <div style={{ color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 12 }}>{singleResult.error}</div>
                    ) : (
                      <div className="grid-2" style={{ gap: 16 }}>
                        <div className="stack" style={{ gap: 10 }}>
                          <div className="form-group">
                            <label className="form-label">Prompt</label>
                            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--accent)", padding: "8px 12px", background: "var(--surface2)", borderRadius: "var(--r2)" }}>"{singleResult.input}"</div>
                          </div>
                          <div className="form-group">
                            <label className="form-label">Detected Intent</label>
                            <div><span className="intent-pill" style={{ fontSize: 12, padding: "4px 10px" }}>{singleResult.data?.intent || singleResult.data?.type || "general_conversation"}</span></div>
                          </div>
                          <div className="form-group">
                            <label className="form-label">CARA Response</label>
                            <div className="turn-bubble turn-agent">{singleResult.data?.assistant?.message || "(no message)"}</div>
                          </div>
                        </div>
                        <div className="form-group">
                          <label className="form-label">Raw Response JSON</label>
                          <div className="response-box">{JSON.stringify(singleResult.data, null, 2)}</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="card">
                  <div className="card-header">
                    <div><div className="card-title">Multi-Turn Conversation Tester</div><div className="card-sub">Test follow-up prompts in the same session context</div></div>
                  </div>
                  <MultiTurnTester config={config} brand={activeProject.brand} addLog={addLog} />
                </div>
              </div>
            )}

            {/* ── TEST CASES PAGE ──────────────────────────────────────── */}
            {page === "cases" && casesSubTab === "prd" && (
              <PRDTestGenerator
                qaRunnerBase="http://localhost:3001"
                existingIds={new Set(testCases.map(tc => tc.id))}
                config={config}
                brand={activeProject.brand}
                evaluateResultFn={evaluateResult}
                deviceIdForTestCaseFn={deviceIdForTestCase}
                downloadAllureReportFn={downloadAllureReport}
                onImport={importedTcs => {
                  setTestCases(prev => {
                    const existing = new Set(prev.map(t => t.id));
                    const fresh    = importedTcs.filter(tc => !existing.has(tc.id));
                    const updated  = importedTcs.filter(tc =>  existing.has(tc.id));
                    const merged   = prev.map(t => {
                      const upd = updated.find(u => u.id === t.id);
                      return upd ? { ...t, ...upd } : t;
                    });
                    return [...merged, ...fresh];
                  });
                  showToast(`${importedTcs.length} test cases imported from PRD`, "success");
                  addLog("ok", `PRD Analyzer imported ${importedTcs.length} test cases`);
                }}
              />
            )}

            {page === "cases" && casesSubTab === "manage" && (
              <div className="stack fade-in" style={{ gap: 20 }}>

                {/* ── Uploads ── */}
                <div className="card" style={{ borderColor: testCases.length ? "rgba(16,185,129,0.3)" : "rgba(245,158,11,0.35)" }}>
                  <div className="card-header">
                    <div>
                      <div className="card-title">Uploads</div>
                      <div className="card-sub">Upload a file to bulk-load test cases, or add them manually below · Requirement document is optional but improves Judge LLM accuracy</div>
                    </div>
                    {testCases.length
                      ? <span className="badge badge-pass">Ready to Run</span>
                      : <span className="badge badge-skip">Upload Test Cases</span>
                    }
                  </div>
                  <div className="grid-2" style={{ gap: 16 }}>

                    {/* Test Case File */}
                    <div className="stack" style={{ gap: 10 }}>
                      <div style={{ fontSize: 11, color: "var(--text2)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.5px" }}>1 — Test Case File (Excel / CSV) <span style={{ color: "var(--text3)", textTransform: "none", letterSpacing: 0 }}>— optional if cases added manually</span></div>
                      <label
                        className="upload-zone"
                        style={{ cursor: "pointer", padding: 20 }}
                        htmlFor="tc-file-upload"
                      >
                        <div className="upload-icon">{testCases.length ? "✓" : "↑"}</div>
                        {testCases.length
                          ? <div style={{ fontSize: 13, color: "var(--accent3)", fontWeight: 600 }}>{testCases.length} test cases loaded</div>
                          : <div style={{ fontSize: 13, color: "var(--text2)" }}>Click to upload regression sheet</div>
                        }
                        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 6 }}>Accepts .xlsx / .csv · Must contain "Test Case ID" column</div>
                      </label>
                      <input id="tc-file-upload" type="file" accept=".xlsx,.csv" style={{ display: "none" }} onChange={handleFileUpload} />
                      {testCases.length > 0 && (
                        <div style={{ fontSize: 11, color: "var(--accent3)", fontFamily: "var(--mono)" }}>
                          ✓ {testCases.length} test cases — {testCases[0]?.module || "Mixed modules"}
                        </div>
                      )}
                    </div>

                    {/* Requirement Document */}
                    <div className="stack" style={{ gap: 10 }}>
                      <div style={{ fontSize: 11, color: "var(--text2)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.5px" }}>2 — Requirement Document (PDF / DOCX / TXT) <span style={{ color: "var(--text3)", textTransform: "none", letterSpacing: 0 }}>— optional</span></div>
                      <label
                        className="upload-zone"
                        style={{ cursor: reqDocUploading ? "wait" : "pointer", padding: 20, borderColor: requirementDoc ? "var(--accent3)" : undefined }}
                        htmlFor="req-doc-upload"
                      >
                        <div className="upload-icon">{requirementDoc ? "✓" : reqDocUploading ? "…" : "↑"}</div>
                        {reqDocUploading
                          ? <div style={{ fontSize: 13, color: "var(--warn)" }}>Parsing document…</div>
                          : requirementDoc
                            ? <div style={{ fontSize: 13, color: "var(--accent3)", fontWeight: 600 }}>{requirementDoc.name}</div>
                            : <div style={{ fontSize: 13, color: "var(--text2)" }}>Click to upload requirements doc</div>
                        }
                        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 6 }}>
                          {requirementDoc
                            ? `${requirementDoc.wordCount} words · ${(requirementDoc.size / 1024).toFixed(1)} KB`
                            : "Accepts .pdf / .docx / .txt · Used by Judge LLM (LLM 2) to enhance expected results"
                          }
                        </div>
                      </label>
                      <input id="req-doc-upload" type="file" accept=".pdf,.docx,.txt" style={{ display: "none" }} onChange={handleRequirementDocUpload} disabled={reqDocUploading} />
                      {requirementDoc && (
                        <button className="btn btn-secondary" style={{ fontSize: 11, alignSelf: "flex-start" }} onClick={() => setRequirementDoc(null)}>
                          ✕ Remove
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="card-header"><div className="card-title">Add Test Case</div></div>
                  <div className="grid-3" style={{ gap: 12, marginBottom: 12 }}>
                    <div className="form-group">
                      <label className="form-label">Test Case ID</label>
                      <input className="form-input" placeholder="TC_NAV_001" value={newTc.id} onChange={e => setNewTc(p => ({ ...p, id: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Module</label>
                      <select className="form-select" value={newTc.module} onChange={e => setNewTc(p => ({ ...p, module: e.target.value }))}>
                        {MODULES.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Expected Intent</label>
                      <select className="form-select" value={newTc.expectedIntent} onChange={e => setNewTc(p => ({ ...p, expectedIntent: e.target.value }))}>
                        {EXPECTED_INTENTS.map(i => <option key={i} value={i}>{i}</option>)}
                      </select>
                    </div>
                    <div className="form-group" style={{ gridColumn: "1/-1" }}>
                      <label className="form-label">Voice Input / Prompt</label>
                      <input className="form-input" placeholder='"Navigate to Marina Beach."' value={newTc.input} onChange={e => setNewTc(p => ({ ...p, input: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Session ID</label>
                      <input className="form-input" placeholder="MULTI_001" value={newTc.sessionId} onChange={e => setNewTc(p => ({ ...p, sessionId: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Turn Number</label>
                      <input className="form-input" type="number" min={1} value={newTc.turnNo} onChange={e => setNewTc(p => ({ ...p, turnNo: parseInt(e.target.value) || 1 }))} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Conversation Flow</label>
                      <select className="form-select" value={newTc.flow} onChange={e => setNewTc(p => ({ ...p, flow: e.target.value }))}>
                        <option>Single Turn</option><option>Multi-Turn</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="card-header">
                    <div><div className="card-title">All Test Cases</div><div className="card-sub">{testCases.length} total · {activeProject.name}</div></div>
                    <button className="btn btn-danger" onClick={() => { if (window.confirm("Clear all test cases?")) setTestCases([]); }}>Clear All</button>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>TC ID</th><th>Session</th><th>Turn</th><th>Module</th><th>Category</th><th>Type</th><th>Flow</th><th>Voice Input (Prompt)</th><th>Expected Intent</th><th>Expected Response</th><th></th></tr></thead>
                      <tbody>
                        {testCases.map(tc => (
                          <tr key={tc.id}>
                            <td className="td-mono">{tc.id}</td>
                            <td className="td-mono">{tc.sessionId || "—"}</td>
                            <td className="td-mono">{tc.turnNo || 1}</td>
                            <td><span className="chip">{tc.module}</span></td>
                            <td style={{ fontSize: 11, color: "var(--text3)" }}>{tc.testCategory || "—"}</td>
                            <td style={{ fontSize: 11, color: "var(--text3)" }}>{tc.testType || "—"}</td>
                            <td><span className={`badge ${tc.flow === "Multi-Turn" ? "badge-run" : "badge-idle"}`}>{tc.flow}</span></td>
                            <td style={{ maxWidth: 260, color: "var(--text)", fontSize: 12 }}>{tc.input}</td>
                            <td><span className="intent-pill">{tc.expectedIntent}</span></td>
                            <td style={{ maxWidth: 220, fontSize: 11, color: "var(--text3)" }}>{tc.expectedResponse ? tc.expectedResponse.slice(0, 80) + (tc.expectedResponse.length > 80 ? "…" : "") : "—"}</td>
                            <td><button className="btn btn-danger" style={{ fontSize: 10, padding: "3px 8px" }} onClick={() => setTestCases(prev => prev.filter(t => t.id !== tc.id))}>Remove</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* ── CONFIG PAGE ──────────────────────────────────────────── */}
            {page === "config" && (
              <div className="stack fade-in" style={{ gap: 20 }}>
                <div className="card">
                  <div className="card-header">
                    <div>
                      <div className="card-title">Project: {activeProject.name}</div>
                      <div className="card-sub">{activeProject.description}</div>
                    </div>
                    <button className="btn btn-secondary" onClick={() => setProjectModal(activeProject)}>✎ Edit Project</button>
                  </div>
                  <div className="grid-2" style={{ gap: 12 }}>
                    <div className="form-group">
                      <label className="form-label">Backend URL</label>
                      <input className="form-input" value={config.backendUrl} onChange={e => setConfig(p => ({ ...p, backendUrl: e.target.value }))} placeholder="http://localhost:9090" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Device ID</label>
                      <input className="form-input" value={config.deviceId} onChange={e => setConfig(p => ({ ...p, deviceId: e.target.value }))} />
                    </div>
                  </div>
                  <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="btn btn-secondary" onClick={async () => {
                      try {
                        addLog("info", `Testing connection to ${config.backendUrl}/health…`);
                        const health = await checkBackendHealth(config.backendUrl);
                        addLog("ok", `Backend is healthy ✓ (status: ${health.status || "ok"})`);
                        showToast("Backend connection successful", "success");
                      } catch (e) {
                        addLog("err", `Cannot reach backend: ${e.message}`);
                        showToast(`Connection failed: ${e.message}`, "error");
                      }
                    }}>Test Connection</button>
                  </div>
                  <div style={{ marginTop: 16, padding: "12px 14px", background: "var(--surface2)", borderRadius: "var(--r2)", fontSize: 12, color: "var(--text3)", lineHeight: 1.6 }}>
                    <div style={{ color: "var(--text2)", fontWeight: 600, marginBottom: 6 }}>cara_backend integration</div>
                    Text regression uses <span className="td-mono">POST /api/v1/process-text</span> on this URL.
                    Voice E2E (Voice E2E tab) runs LiveKit suites from <span className="td-mono">backend-feature-demo-develop/cara_backend</span> via qa-runner on port 3001.
                    Start the API with <span className="td-mono">python -m src.main</span> and the agent with <span className="td-mono">python -m src.agent.main</span> inside cara_backend.
                  </div>
                </div>

                <div className="card">
                  <div className="card-header"><div className="card-title">Session Parameters</div></div>
                  <div className="grid-3" style={{ gap: 12 }}>
                    <div className="form-group">
                      <label className="form-label">Language</label>
                      <select className="form-select" value={config.language} onChange={e => setConfig(p => ({ ...p, language: e.target.value }))}>
                        {["en","hi","ta","te","kn","ml","gu","mr","bn","pa","ur","zh","ko","ja"].map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Timezone</label>
                      <input className="form-input" value={config.timezone} onChange={e => setConfig(p => ({ ...p, timezone: e.target.value }))} placeholder="Asia/Kolkata" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Pipeline Mode</label>
                      <select className="form-select" value={config.pipeline} onChange={e => setConfig(p => ({ ...p, pipeline: e.target.value }))}>
                        <option value="modular">Modular (STT→LLM→TTS)</option>
                        <option value="realtime">Realtime (OpenAI/Gemini)</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Model Name</label>
                      <select className="form-select" value={config.modelName} onChange={e => setConfig(p => ({ ...p, modelName: e.target.value }))}>
                        <option value="gpt-5.4-nano">gpt-5.4-nano (Executor)</option>
                        <option value="gpt-4o-mini">gpt-4o-mini</option>
                        <option value="gpt-4o">gpt-4o</option>
                        <option value="gemini">gemini (requires Gemini API)</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Latitude</label>
                      <input className="form-input" value={config.latitude} onChange={e => setConfig(p => ({ ...p, latitude: e.target.value }))} placeholder="12.9716" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Longitude</label>
                      <input className="form-input" value={config.longitude} onChange={e => setConfig(p => ({ ...p, longitude: e.target.value }))} placeholder="77.5946" />
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="card-header"><div className="card-title">All Projects</div><button className="btn btn-primary" style={{ fontSize: 11 }} onClick={() => setProjectModal("new")}>+ New Project</button></div>
                  <div className="stack" style={{ gap: 8 }}>
                    {projects.map(p => (
                      <div key={p.id} className="card-sm" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: p.id === activeProjectId ? "var(--accent)" : "var(--text)" }}>{p.name}</div>
                          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2, fontFamily: "var(--mono)" }}>{p.config.backendUrl} · {p.testCases.length} TCs</div>
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          {p.id !== activeProjectId && <button className="btn btn-secondary" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => setActiveProjectId(p.id)}>Switch</button>}
                          {p.id === activeProjectId && <span className="badge badge-run">Active</span>}
                          <button className="btn btn-secondary" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => setProjectModal(p)}>Edit</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="card">
                  <div className="card-header"><div className="card-title">RPC Mock Responses</div></div>
                  <div className="card-sub" style={{ marginBottom: 12 }}>The tool automatically ACKs all RPC calls from CARA agent with mock responses.</div>
                  <div className="grid-2" style={{ gap: 8 }}>
                    {Object.entries(RPC_TYPES).map(([type, label]) => (
                      <div key={type} className="card-sm" style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent3)", flexShrink: 0 }} />
                        <div>
                          <div style={{ fontSize: 12, color: "var(--text)" }}>{label}</div>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text3)" }}>{type}</div>
                        </div>
                        <span className="badge badge-pass" style={{ marginLeft: "auto" }}>Auto-ACK</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── REPORT PAGE ──────────────────────────────────────────── */}
            {page === "report" && (
              <div className="stack fade-in" style={{ gap: 20 }}>
                {!reportData ? (
                  <div className="empty">
                    <div className="empty-icon">📊</div>
                    <div style={{ fontSize: 14, marginBottom: 8 }}>No report yet</div>
                    <div style={{ fontSize: 12, color: "var(--text3)" }}>Run the regression suite to generate a report</div>
                    <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setPage("run")}>Go to Run Page</button>
                  </div>
                ) : (
                  <>
                    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                      <div className="grid-4" style={{ flex: 1 }}>
                        <div className="stat green"><div className="stat-val">{reportData.pass}</div><div className="stat-label">Pass</div></div>
                        <div className="stat red"><div className="stat-val">{reportData.fail}</div><div className="stat-label">Fail</div></div>
                        <div className="stat accent"><div className="stat-val">{reportData.total}</div><div className="stat-label">Total Run</div></div>
                        <div className="stat">
                          <div className="stat-val" style={{ color: reportData.passPct >= 80 ? "var(--accent3)" : reportData.passPct >= 60 ? "var(--warn)" : "var(--danger)" }}>{reportData.passPct}%</div>
                          <div className="stat-label">Pass Rate</div>
                        </div>
                      </div>
                      <div className="card" style={{ padding: "16px 20px", flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                        <ScoreRing pct={reportData.passPct} color={reportData.passPct >= 80 ? "#10b981" : reportData.passPct >= 60 ? "#f59e0b" : "#ef4444"} />
                        <button className="btn btn-success" style={{ fontSize: 11 }} onClick={() => exportReport(reportData, null, "html")}>↓ HTML Report</button>
                        <button className="btn btn-outline"  style={{ fontSize: 10, padding:"3px 8px" }} onClick={() => exportReport(reportData, null, "csv")}>↓ CSV</button>
                      </div>
                    </div>

                    <div className="card">
                      <div className="card-header"><div className="card-title">Module Breakdown</div></div>
                      <div className="table-wrap">
                        <table>
                          <thead><tr><th>Module</th><th>Total</th><th>Pass</th><th>Fail</th><th>Pass Rate</th><th>Progress</th></tr></thead>
                          <tbody>
                            {(() => {
                              const mods = {};
                              testCases.forEach(tc => {
                                if (!mods[tc.module]) mods[tc.module] = { total: 0, pass: 0, fail: 0 };
                                mods[tc.module].total++;
                                const r = reportData.results[tc.id];
                                if (r?.pass) mods[tc.module].pass++;
                                else if (r) mods[tc.module].fail++;
                              });
                              return Object.entries(mods).map(([mod, stats]) => {
                                const pct = stats.total > 0 ? Math.round((stats.pass / stats.total) * 100) : 0;
                                return (
                                  <tr key={mod}>
                                    <td><span className="chip">{mod}</span></td>
                                    <td className="td-mono">{stats.total}</td>
                                    <td className="td-mono" style={{ color: "var(--accent3)" }}>{stats.pass}</td>
                                    <td className="td-mono" style={{ color: stats.fail > 0 ? "var(--danger)" : "var(--text3)" }}>{stats.fail}</td>
                                    <td className="td-mono" style={{ color: pct >= 80 ? "var(--accent3)" : pct >= 50 ? "var(--warn)" : "var(--danger)" }}>{pct}%</td>
                                    <td style={{ minWidth: 100 }}>
                                      <div className="progress-bar">
                                        <div className="progress-fill" style={{ width: `${pct}%`, background: pct >= 80 ? "var(--accent3)" : pct >= 50 ? "var(--warn)" : "var(--danger)" }} />
                                      </div>
                                    </td>
                                  </tr>
                                );
                              });
                            })()}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="card">
                      <div className="card-header">
                        <div className="card-title">Detailed Results</div>
                        <span className="badge badge-idle">{reportData.runAt}</span>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead><tr><th>TC ID</th><th>Module</th><th>Input</th><th>Expected</th><th>Actual</th><th>Intent → Tool → Handler</th><th>Result</th><th>Conf.</th><th>CARA Response</th></tr></thead>
                          <tbody>
                            {testCases.map(tc => {
                              const r   = reportData.results[tc.id];
                              const tc_ = r?.toolCheck;
                              const ic  = r?.intentChain;
                              const routeOk = !tc_ || tc_.isCorrect !== false;
                              return (
                                <tr key={tc.id} className={r?.pass ? "tc-row-pass" : r ? "tc-row-fail" : ""}>
                                  <td className="td-mono">{tc.id}</td>
                                  <td><span className="chip">{tc.module}</span></td>
                                  <td style={{ maxWidth: 180, color: "var(--text)", fontSize: 12 }}>{tc.input}</td>
                                  <td><span className="intent-pill">{tc.expectedIntent}</span></td>
                                  <td>{r ? <span className="intent-pill" style={{ background: r.intentMatch ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)", color: r.intentMatch ? "var(--accent3)" : "var(--danger)" }}>{r.actualIntent}</span> : "—"}</td>
                                  <td style={{ fontSize: 10, lineHeight: 1.5, minWidth: 160 }}>
                                    {r ? (
                                      <span title={tc_?.warning || ic?.chain || ""}>
                                        <span style={{ color: "var(--text3)" }}>{ic?.intent ?? tc.expectedIntent}</span>
                                        <span style={{ color: "var(--text3)", margin: "0 3px" }}>→</span>
                                        <span style={{ color: routeOk ? "var(--accent3)" : "var(--danger)", fontWeight: 600 }}>
                                          {routeOk ? "✓" : "⚠"} {tc_?.actualTool ?? ic?.tool ?? "—"}
                                        </span>
                                        <br />
                                        <span style={{ color: "var(--text3)", fontStyle: "italic" }}>
                                          {ic?.handlerShort ?? "—"}
                                        </span>
                                      </span>
                                    ) : "—"}
                                  </td>
                                  <td>
                                    {r ? <>
                                      <span className={`badge ${r.pass ? "badge-pass" : "badge-fail"}`}>{r.pass ? "PASS" : "FAIL"}</span>
                                      {r.reviewFlag === "fail_but_high_content_match" && (
                                        <span className="badge-review" title={`Auto-corrected: heuristic said FAIL but content score was high (was ${r.heuristicConfidence}%)`}>↑ auto</span>
                                      )}
                                      {r.reviewFlag === "pass_but_low_content_match" && (
                                        <span className="badge-review" title={`Auto-corrected: heuristic said PASS but content score was low (was ${r.heuristicConfidence}%)`}>↓ auto</span>
                                      )}
                                    </> : <span className="badge badge-idle">N/A</span>}
                                  </td>
                                  <td className="td-mono">
                                    {r ? `${r.confidence}%` : "—"}
                                    {r?.reviewFlag && r.heuristicConfidence !== r.confidence && (
                                      <span style={{ fontSize: 9, color: "var(--text3)", marginLeft: 4 }}>({r.heuristicConfidence}% raw)</span>
                                    )}
                                  </td>
                                  <td style={{ maxWidth: 240, fontSize: 11, color: "var(--text3)" }}>
                                    {r?.message ? r.message.slice(0, 100) + (r.message.length > 100 ? "…" : "") : r?.error ? <span style={{ color: "var(--danger)" }}>{r.error.slice(0, 60)}</span> : "—"}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── HISTORY PAGE ──────────────────────────────────────────── */}
            {page === "history" && (
              <div className="stack fade-in" style={{ gap: 16 }}>
                {history.length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">🕒</div>
                    <div style={{ fontSize: 14, marginBottom: 8 }}>No runs yet</div>
                    <div style={{ fontSize: 12, color: "var(--text3)" }}>Completed regression runs will appear here</div>
                    <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setPage("run")}>Run a Test</button>
                  </div>
                ) : (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: 13, color: "var(--text3)", fontFamily: "var(--mono)" }}>{history.length} run{history.length !== 1 ? "s" : ""} across all projects</div>
                      <button className="btn btn-danger" style={{ fontSize: 11 }} onClick={() => { if (window.confirm("Clear all run history?")) setHistory([]); }}>Clear History</button>
                    </div>

                    {history.map(run => (
                      <div key={run.id} className={`history-run-card ${expandedHistory === run.id ? "expanded" : ""}`}
                        onClick={() => setExpandedHistory(expandedHistory === run.id ? null : run.id)}>
                        <div className="history-run-header">
                          <div style={{ width: 40, height: 40, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: run.passPct >= 80 ? "rgba(16,185,129,0.15)" : run.passPct >= 60 ? "rgba(245,158,11,0.15)" : "rgba(239,68,68,0.15)", border: `1px solid ${run.passPct >= 80 ? "rgba(16,185,129,0.3)" : run.passPct >= 60 ? "rgba(245,158,11,0.3)" : "rgba(239,68,68,0.3)"}`, fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: run.passPct >= 80 ? "var(--accent3)" : run.passPct >= 60 ? "var(--warn)" : "var(--danger)" }}>
                            {run.passPct}%
                          </div>
                          <div className="history-run-meta">
                            <div className="history-run-title">{run.projectName}</div>
                            <div className="history-run-sub">{run.runAt} · {run.total} test cases</div>
                          </div>
                          <div className="history-run-stats">
                            <div className="history-stat">
                              <div className="history-stat-val" style={{ color: "var(--accent3)" }}>{run.pass}</div>
                              <div className="history-stat-label">PASS</div>
                            </div>
                            <div className="history-stat">
                              <div className="history-stat-val" style={{ color: "var(--danger)" }}>{run.fail}</div>
                              <div className="history-stat-label">FAIL</div>
                            </div>
                            <button className="btn btn-success" style={{ fontSize: 11 }} onClick={e => { e.stopPropagation(); exportReport(run, run.testCases, "html"); }} title="Allure-style HTML">↓ HTML</button>
                            <button className="btn btn-outline"  style={{ fontSize: 10, padding:"3px 7px" }} onClick={e => { e.stopPropagation(); exportReport(run, run.testCases, "csv"); }}>↓ CSV</button>
                            <svg className={`history-expand ${expandedHistory === run.id ? "open" : ""}`} width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="var(--text3)" strokeWidth={2}>
                              <path d="M4 6l4 4 4-4" />
                            </svg>
                          </div>
                        </div>

                        {expandedHistory === run.id && (
                          <div className="history-detail">
                            <div className="table-wrap">
                              <table>
                                <thead><tr><th>TC ID</th><th>Module</th><th>Input</th><th>Expected</th><th>Actual</th><th>Intent → Tool → Handler</th><th>Result</th><th>Conf.</th></tr></thead>
                                <tbody>
                                  {run.testCases.map(tc => {
                                    const r   = run.results[tc.id];
                                    const tc_ = r?.toolCheck;
                                    const ic  = r?.intentChain;
                                    const routeOk = !tc_ || tc_.isCorrect !== false;
                                    return (
                                      <tr key={tc.id} className={r?.pass ? "tc-row-pass" : r ? "tc-row-fail" : ""}>
                                        <td className="td-mono">{tc.id}</td>
                                        <td><span className="chip">{tc.module}</span></td>
                                        <td style={{ maxWidth: 180, color: "var(--text)", fontSize: 12 }}>{tc.input}</td>
                                        <td><span className="intent-pill">{tc.expectedIntent}</span></td>
                                        <td>{r ? <span className="intent-pill" style={{ background: r.intentMatch ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)", color: r.intentMatch ? "var(--accent3)" : "var(--danger)" }}>{r.actualIntent}</span> : "—"}</td>
                                        <td style={{ fontSize: 10, lineHeight: 1.5, minWidth: 160 }}>
                                          {r ? (
                                            <span title={tc_?.warning || ic?.chain || ""}>
                                              <span style={{ color: "var(--text3)" }}>{ic?.intent ?? tc.expectedIntent}</span>
                                              <span style={{ color: "var(--text3)", margin: "0 3px" }}>→</span>
                                              <span style={{ color: routeOk ? "var(--accent3)" : "var(--danger)", fontWeight: 600 }}>
                                                {routeOk ? "✓" : "⚠"} {tc_?.actualTool ?? ic?.tool ?? "—"}
                                              </span>
                                              <br />
                                              <span style={{ color: "var(--text3)", fontStyle: "italic" }}>
                                                {ic?.handlerShort ?? "—"}
                                              </span>
                                            </span>
                                          ) : "—"}
                                        </td>
                                        <td>
                                          {r ? <>
                                            <span className={`badge ${r.pass ? "badge-pass" : "badge-fail"}`}>{r.pass ? "PASS" : "FAIL"}</span>
                                            {r.reviewFlag === "fail_but_high_content_match" && (
                                              <span className="badge-review" title={`Auto-corrected: heuristic said FAIL, content score was high (raw ${r.heuristicConfidence}%)`}>↑ auto</span>
                                            )}
                                            {r.reviewFlag === "pass_but_low_content_match" && (
                                              <span className="badge-review" title={`Auto-corrected: heuristic said PASS, content score was low (raw ${r.heuristicConfidence}%)`}>↓ auto</span>
                                            )}
                                          </> : <span className="badge badge-idle">N/A</span>}
                                        </td>
                                        <td className="td-mono">
                                          {r ? `${r.confidence}%` : "—"}
                                          {r?.reviewFlag && r.heuristicConfidence !== r.confidence && (
                                            <span style={{ fontSize: 9, color: "var(--text3)", marginLeft: 4 }}>({r.heuristicConfidence}% raw)</span>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

          </div>
        </main>
      </div>
    </>
  );
}

// ─── Multi-Turn Tester Component ──────────────────────────────────────────────
function MultiTurnTester({ config, brand, addLog }) {
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(`multi-${Date.now()}`);

  async function sendTurn() {
    if (!input.trim() || loading) return;
    const userText = input.trim();
    setInput(""); setLoading(true);
    setTurns(p => [...p, { role: "user", text: userText, ts: new Date().toLocaleTimeString() }]);
    try {
      const data = await processText({
        config,
        brand,
        text: userText,
        deviceId: `${config.deviceId}-${sessionId}`,
      });
      const msg = data.assistant?.message || "(no response)";
      const intent = data.intent || data.type || "general_conversation";
      setTurns(p => [...p, { role: "agent", text: msg, intent, ts: new Date().toLocaleTimeString() }]);
      addLog("ok", `Multi-turn intent=${intent}`);
    } catch (e) {
      setTurns(p => [...p, { role: "agent", text: `Error: ${e.message}`, intent: "error", ts: new Date().toLocaleTimeString() }]);
      addLog("err", `Multi-turn failed: ${e.message}`);
    }
    setLoading(false);
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text3)", letterSpacing: 1 }}>SESSION: {sessionId}</div>
      <div className="stack" style={{ gap: 8, maxHeight: 280, overflowY: "auto" }}>
        {turns.length === 0 && <div style={{ color: "var(--text3)", fontSize: 12, textAlign: "center", padding: "20px 0" }}>Start a conversation with CARA below…</div>}
        {turns.map((t, i) => (
          <div key={i}>
            <div className="turn-label">{t.role === "user" ? "You" : `CARA · ${t.intent}`} · {t.ts}</div>
            <div className={`turn-bubble ${t.role === "user" ? "turn-user" : "turn-agent"}`}>{t.text}</div>
          </div>
        ))}
        {loading && <div className="turn-bubble turn-agent" style={{ color: "var(--text3)" }}>Processing…</div>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="form-input" value={input} onChange={e => setInput(e.target.value)}
          placeholder='Say something to CARA… (e.g. "Play Kamli from Dhoom 3")'
          onKeyDown={e => e.key === "Enter" && sendTurn()} />
        <button className="btn btn-primary" onClick={sendTurn} disabled={loading || !input.trim()}>Send</button>
        <button className="btn btn-secondary" onClick={() => setTurns([])}>Clear</button>
      </div>
    </div>
  );
}
