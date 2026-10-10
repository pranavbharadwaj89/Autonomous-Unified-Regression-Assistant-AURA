import { useState, useRef, useEffect, useCallback } from "react";

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
// Accepts an ArrayBuffer from FileReader. Returns an array of parsed test case objects.
// Column matching is fuzzy — works with any case / spacing variation.
async function parseExcelBuffer(buffer, fileName) {
  const XLSX = await loadXLSX();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  if (rows.length === 0) throw new Error("Sheet is empty or has no data rows.");

  // Fuzzy column resolver: finds the best-matching key in the row for a set of aliases
  function col(row, ...aliases) {
    const keys = Object.keys(row);
    for (const alias of aliases) {
      const a = alias.toLowerCase().replace(/[\s_\-]/g, "");
      const match = keys.find(k => k.toLowerCase().replace(/[\s_\-]/g, "") === a);
      if (match !== undefined) return String(row[match]).trim();
    }
    return "";
  }

  const testCases = rows
    .filter(row => col(row, "id", "tcid", "testcaseid", "tc_id", "testid") || col(row, "input", "voiceinput", "prompt", "text", "query"))
    .map((row, idx) => {
      const id        = col(row, "id", "tcid", "testcaseid", "tc_id", "testid") || `TC_${String(idx + 1).padStart(3, "0")}`;
      const module    = col(row, "module", "category", "area", "feature") || "General";
      const input     = col(row, "input", "voiceinput", "prompt", "text", "query", "utterance");
      const expectedIntent = col(row, "expectedintent", "expected_intent", "intent", "expectedtype", "expected") || "general_conversation";
      const flow      = col(row, "flow", "conversationflow", "type", "testtype") || "Single Turn";
      const sessionId = col(row, "sessionid", "session_id", "session") || id;
      const turnNoRaw = col(row, "turnno", "turn_no", "turnnum", "turn", "turnnumber");
      const turnNo    = parseInt(turnNoRaw) || 1;

      return { id, module, input, expectedIntent, flow, sessionId, turnNo };
    })
    .filter(tc => tc.input); // drop rows with no input

  if (testCases.length === 0) throw new Error("No valid test cases found. Check that the sheet has an 'Input' column.");

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

const DEFAULT_CONFIG = {
  backendUrl: "http://localhost:9090", deviceId: "cara-regression-tool-001",
  language: "en", timezone: "Asia/Kolkata", latitude: "12.9716", longitude: "77.5946",
  pipeline: "modular", modelName: "gemini",
};

// Default projects
const INITIAL_PROJECTS = [
  { id: "proj_citroen", name: "Citroën IVI", description: "In-vehicle infotainment testing for Citroën", brand: "citroen", config: { ...DEFAULT_CONFIG }, testCases: SAMPLE_TCS },
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
    id: "proj_" + genId(), name: "", description: "", brand: "citroen",
    config: { ...DEFAULT_CONFIG }, testCases: [],
  });
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{isEdit ? "Edit Project" : "New Project"}</div>
        <div className="stack" style={{ gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Project Name</label>
            <input className="form-input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Citroën IVI" />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input className="form-input" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Short description of this project" />
          </div>
          <div className="form-group">
            <label className="form-label">Brand (X-Brand header)</label>
            <input className="form-input" value={form.brand} onChange={e => setForm(p => ({ ...p, brand: e.target.value }))} placeholder="citroen" />
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
                <option value="gemini">gemini</option>
                <option value="gpt-4o-mini">gpt-4o-mini</option>
                <option value="gpt-4o">gpt-4o</option>
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
    { level: "info", msg: "CARA Automation Tool v2.0 — Ready" },
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

  // ── API Calls ──────────────────────────────────────────────────────────────
  async function callProcessText(text, sessionDeviceId) {
    const url = `${config.backendUrl}/api/v1/process-text`;
    const body = {
      text, deviceId: sessionDeviceId || config.deviceId,
      language: config.language, model_name: config.modelName,
      user_timezone: config.timezone,
      latitude: parseFloat(config.latitude) || null,
      longitude: parseFloat(config.longitude) || null,
      include_tts: false,
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Brand": activeProject.brand || "citroen" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp.json();
  }

  function evaluateResult(data, tc) {
    const actualIntent = data.intent || data.type || "general_conversation";
    const intentMatch = actualIntent === tc.expectedIntent ||
      (tc.expectedIntent === "music" && ["music", "youtube_music"].includes(actualIntent)) ||
      (tc.expectedIntent === "sos" && actualIntent === "sos") ||
      (tc.expectedIntent === "navigation" && actualIntent === "navigation");
    const hasResponse = !!(data.assistant?.message || data.transcription);
    const pass = intentMatch && hasResponse;
    const msg = (data.assistant?.message || "").toLowerCase();
    const isErrorMsg = msg.includes("error") || msg.includes("couldn't") || msg.includes("unable");
    const isRepeatMsg = msg.includes("please repeat") || msg.includes("say that again");
    const confidence = intentMatch ? (isErrorMsg || isRepeatMsg ? 60 : 90) : 30;
    return { pass, intentMatch, confidence, actualIntent, message: data.assistant?.message || "" };
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

  // ── Full Regression Run ─────────────────────────────────────────────────────
  async function runRegression() {
    if (running || testCases.length === 0) return;
    setRunning(true); setRunProgress(0); setResults({});
    const runResults = {};
    addLog("accent", `▶ Starting regression run — ${testCases.length} test cases`);
    addLog("info", `Pipeline: ${config.pipeline} | Model: ${config.modelName} | Language: ${config.language}`);
    const sessions = {};
    testCases.forEach(tc => {
      const sid = tc.sessionId || tc.id;
      if (!sessions[sid]) sessions[sid] = [];
      sessions[sid].push(tc);
    });
    Object.values(sessions).forEach(s => s.sort((a, b) => (a.turnNo || 1) - (b.turnNo || 1)));
    let done = 0;
    for (const [sid, turns] of Object.entries(sessions)) {
      const sessionDeviceId = `${config.deviceId}-${sid}`;
      addLog("purple", `Session: ${sid} (${turns.length} turn${turns.length > 1 ? "s" : ""})`);
      for (const tc of turns) {
        setCurrentTcId(tc.id);
        addLog("info", `  [${tc.id}] "${tc.input}"`);
        try {
          const data = await callProcessText(tc.input, sessionDeviceId);
          const eval_ = evaluateResult(data, tc);
          runResults[tc.id] = { ...eval_, raw: data, rpcType: data.type || null, timestamp: new Date().toISOString() };
          addLog(eval_.pass ? "ok" : "err", `  ${eval_.pass ? "✓" : "✗"} ${tc.id} — intent: ${eval_.actualIntent} — ${eval_.pass ? "PASS" : "FAIL"} (${eval_.confidence}%)`);
        } catch (e) {
          runResults[tc.id] = { pass: false, intentMatch: false, confidence: 0, error: e.message, actualIntent: "error", message: "" };
          addLog("err", `  ✗ ${tc.id} — ERROR: ${e.message}`);
        }
        done++;
        setRunProgress(Math.round((done / testCases.length) * 100));
        setResults({ ...runResults });
        await new Promise(r => setTimeout(r, 300));
      }
    }
    setCurrentTcId(null); setRunning(false);
    const pass = Object.values(runResults).filter(r => r.pass).length;
    const fail = Object.values(runResults).filter(r => !r.pass).length;
    const total = Object.keys(runResults).length;
    const passPct = total > 0 ? Math.round((pass / total) * 100) : 0;
    const rd = { pass, fail, total, passPct, results: runResults, runAt: new Date().toLocaleString() };
    setReportData(rd);

    // Save to history
    const histEntry = {
      id: "run_" + genId(), projectId: activeProjectId, projectName: activeProject.name,
      runAt: rd.runAt, pass, fail, total, passPct, results: runResults,
      testCases: [...testCases],
    };
    setHistory(prev => [histEntry, ...prev]);

    addLog("accent", `▶ Run complete: ${pass}/${total} PASS (${passPct}%)`);
    showToast(`Run complete — ${pass}/${total} passed (${passPct}%)`, passPct >= 80 ? "success" : "error");
    setPage("report");
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
      addLog("info", `  Sample — ID: ${sample.id} | Module: ${sample.module} | Intent: ${sample.expectedIntent} | Flow: ${sample.flow}`);

      showToast(`File Uploaded Successfully — ${parsed.length} test cases loaded`, "success");
    } catch (err) {
      addLog("err", `Upload failed: ${err.message}`);
      showToast(`Upload failed: ${err.message}`, "error");
    }
  }

  // ── Export Report ───────────────────────────────────────────────────────────
  function exportReport(rd, tcs) {
    if (!rd) return;
    const useTcs = tcs || testCases;
    const rows = [
      ["Test Case ID","Module","Input","Expected Intent","Actual Intent","Pass/Fail","Confidence","Response","Error"],
      ...useTcs.map(tc => {
        const r = rd.results[tc.id] || {};
        return [tc.id, tc.module, tc.input, tc.expectedIntent, r.actualIntent || "", r.pass ? "PASS" : "FAIL", r.confidence || 0, r.message || "", r.error || ""];
      })
    ];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `CARA_Report_${activeProject.name.replace(/\s+/g, "_")}_${Date.now()}.csv`; a.click();
    addLog("ok", "Report exported as CSV");
    showToast("Report downloaded", "success");
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
  const totalPass = Object.values(results).filter(r => r.pass).length;
  const totalFail = Object.values(results).filter(r => !r.pass).length;
  const totalRun = Object.keys(results).length;

  const navItems = [
    { id: "run", label: "Run Tests" },
    { id: "single", label: "Single Voice Test" },
    { id: "cases", label: "Test Cases" },
    { id: "config", label: "Configuration" },
    { id: "report", label: "Report" },
    { id: "history", label: "History" },
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
            <div className="logo-mark">CARA</div>
            <div className="logo-sub">Regression Automation</div>
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
                {n.id === "history" && history.length > 0 && (
                  <span className="badge badge-idle" style={{ marginLeft: "auto", fontSize: 9 }}>{history.length}</span>
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
                {page === "run" && "Regression Run"}
                {page === "single" && "Single Voice Test"}
                {page === "cases" && "Test Cases"}
                {page === "config" && "Configuration"}
                {page === "report" && "Test Report"}
                {page === "history" && "Run History"}
              </div>
              <div className="page-sub">{activeProject.name} · CARA Automation</div>
            </div>
            <div className="topbar-actions">
              {page === "run" && (
                <>
                  <button className="btn btn-secondary" onClick={() => document.getElementById("excel-upload").click()}>
                    ↑ Upload Excel
                  </button>
                  <input id="excel-upload" type="file" accept=".xlsx,.csv" style={{ display: "none" }} onChange={handleFileUpload} />
                  <button className="btn btn-primary" onClick={runRegression} disabled={running || testCases.length === 0}>
                    {running ? `Running… ${runProgress}%` : "▶ Run Regression"}
                  </button>
                </>
              )}
              {page === "report" && reportData && (
                <button className="btn btn-success" onClick={() => exportReport(reportData)}>↓ Download Report</button>
              )}
              {page === "cases" && (
                <button className="btn btn-primary" onClick={() => {
                  if (!newTc.id || !newTc.input) return;
                  setTestCases(prev => [...prev, { ...newTc, id: newTc.id || genId() }]);
                  setNewTc({ id: "", module: MODULES[0], input: "", expectedIntent: "general_conversation", sessionId: "", turnNo: 1, flow: "Single Turn" });
                  addLog("ok", `Added test case ${newTc.id}`);
                  showToast(`Test case ${newTc.id} added`, "success");
                }}>+ Add Test Case</button>
              )}
            </div>
          </div>

          <div className="content">

            {/* ── RUN PAGE ──────────────────────────────────────────────── */}
            {page === "run" && (
              <div className="stack fade-in" style={{ gap: 20 }}>
                <div className="grid-4">
                  <div className="stat"><div className="stat-val">{testCases.length}</div><div className="stat-label">Total Test Cases</div></div>
                  <div className="stat green"><div className="stat-val">{totalPass}</div><div className="stat-label">Pass</div></div>
                  <div className="stat red"><div className="stat-val">{totalFail}</div><div className="stat-label">Fail</div></div>
                  <div className="stat accent"><div className="stat-val">{totalRun > 0 ? Math.round((totalPass / totalRun) * 100) : 0}%</div><div className="stat-label">Pass Rate</div></div>
                </div>

                {running && (
                  <div className="card">
                    <div className="row-between" style={{ marginBottom: 10 }}>
                      <div>
                        <div className="card-title">Running Regression Suite</div>
                        <div className="card-sub" style={{ fontFamily: "var(--mono)" }}>{currentTcId ? `Current: ${currentTcId}` : "Initializing…"}</div>
                      </div>
                      <span className="badge badge-run">{runProgress}%</span>
                    </div>
                    <div className="progress-bar"><div className="progress-fill" style={{ width: `${runProgress}%` }} /></div>
                  </div>
                )}

                <div className="card" style={{ gridColumn: "1/-1" }}>
                  <div className="card-header">
                    <div><div className="card-title">Test Results</div><div className="card-sub">{totalRun} / {testCases.length} executed</div></div>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>TC ID</th><th>Module</th><th>Voice Input</th><th>Expected Intent</th><th>Actual Intent</th><th>Status</th><th>Confidence</th><th>Response</th></tr>
                      </thead>
                      <tbody>
                        {testCases.map(tc => {
                          const r = results[tc.id];
                          const isRunning = currentTcId === tc.id;
                          return (
                            <tr key={tc.id} className={isRunning ? "tc-row-running" : r?.pass ? "tc-row-pass" : r ? "tc-row-fail" : ""}>
                              <td className="td-mono">{tc.id}</td>
                              <td><span className="chip">{tc.module}</span></td>
                              <td style={{ maxWidth: 200, color: "var(--text)" }}>{tc.input}</td>
                              <td><span className="intent-pill">{tc.expectedIntent}</span></td>
                              <td>{r ? <span className="intent-pill" style={{ background: r.intentMatch ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)", color: r.intentMatch ? "var(--accent3)" : "var(--danger)" }}>{r.actualIntent}</span> : <span className="td-mono" style={{ color: "var(--text3)" }}>—</span>}</td>
                              <td>{isRunning ? <span className="badge badge-run">Running</span> : r ? <span className={`badge ${r.pass ? "badge-pass" : "badge-fail"}`}>{r.pass ? "PASS" : "FAIL"}</span> : <span className="badge badge-idle">Pending</span>}</td>
                              <td className="td-mono">{r ? `${r.confidence}%` : "—"}</td>
                              <td style={{ maxWidth: 220, fontSize: 11, color: "var(--text3)" }}>{r?.message ? r.message.slice(0, 80) + (r.message.length > 80 ? "…" : "") : r?.error ? <span style={{ color: "var(--danger)" }}>{r.error.slice(0, 60)}</span> : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
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
            )}

            {/* ── SINGLE TEST PAGE ──────────────────────────────────────── */}
            {page === "single" && (
              <div className="stack fade-in" style={{ gap: 20 }}>
                <div className="card">
                  <div className="card-header">
                    <div>
                      <div className="card-title">Single Voice Command Test</div>
                      <div className="card-sub">Type or speak a prompt — CARA processes it via POST /process-text</div>
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
            {page === "cases" && (
              <div className="stack fade-in" style={{ gap: 20 }}>
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
                      <thead><tr><th>ID</th><th>Module</th><th>Flow</th><th>Session</th><th>Turn</th><th>Voice Input</th><th>Expected Intent</th><th></th></tr></thead>
                      <tbody>
                        {testCases.map(tc => (
                          <tr key={tc.id}>
                            <td className="td-mono">{tc.id}</td>
                            <td><span className="chip">{tc.module}</span></td>
                            <td><span className={`badge ${tc.flow === "Multi-Turn" ? "badge-run" : "badge-idle"}`}>{tc.flow}</span></td>
                            <td className="td-mono">{tc.sessionId || "—"}</td>
                            <td className="td-mono">{tc.turnNo || 1}</td>
                            <td style={{ maxWidth: 280, color: "var(--text)" }}>{tc.input}</td>
                            <td><span className="intent-pill">{tc.expectedIntent}</span></td>
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
                  <div style={{ marginTop: 12 }}>
                    <button className="btn btn-secondary" onClick={async () => {
                      try {
                        addLog("info", `Testing connection to ${config.backendUrl}/health…`);
                        const r = await fetch(`${config.backendUrl}/health`);
                        if (r.ok) addLog("ok", "Backend is healthy ✓");
                        else addLog("warn", `Backend responded with status ${r.status}`);
                      } catch (e) { addLog("err", `Cannot reach backend: ${e.message}`); }
                    }}>Test Connection</button>
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
                        <option value="gemini">gemini</option>
                        <option value="gpt-4o-mini">gpt-4o-mini</option>
                        <option value="gpt-4o">gpt-4o</option>
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
                        <button className="btn btn-success" style={{ fontSize: 11 }} onClick={() => exportReport(reportData)}>↓ Download CSV</button>
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
                          <thead><tr><th>TC ID</th><th>Module</th><th>Input</th><th>Expected</th><th>Actual</th><th>Result</th><th>Confidence</th><th>CARA Response</th></tr></thead>
                          <tbody>
                            {testCases.map(tc => {
                              const r = reportData.results[tc.id];
                              return (
                                <tr key={tc.id} className={r?.pass ? "tc-row-pass" : r ? "tc-row-fail" : ""}>
                                  <td className="td-mono">{tc.id}</td>
                                  <td><span className="chip">{tc.module}</span></td>
                                  <td style={{ maxWidth: 180, color: "var(--text)", fontSize: 12 }}>{tc.input}</td>
                                  <td><span className="intent-pill">{tc.expectedIntent}</span></td>
                                  <td>{r ? <span className="intent-pill" style={{ background: r.intentMatch ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)", color: r.intentMatch ? "var(--accent3)" : "var(--danger)" }}>{r.actualIntent}</span> : "—"}</td>
                                  <td>{r ? <span className={`badge ${r.pass ? "badge-pass" : "badge-fail"}`}>{r.pass ? "PASS" : "FAIL"}</span> : <span className="badge badge-idle">N/A</span>}</td>
                                  <td className="td-mono">{r ? `${r.confidence}%` : "—"}</td>
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
                            <button className="btn btn-success" style={{ fontSize: 11 }} onClick={e => { e.stopPropagation(); exportReport(run, run.testCases); }}>↓ CSV</button>
                            <svg className={`history-expand ${expandedHistory === run.id ? "open" : ""}`} width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="var(--text3)" strokeWidth={2}>
                              <path d="M4 6l4 4 4-4" />
                            </svg>
                          </div>
                        </div>

                        {expandedHistory === run.id && (
                          <div className="history-detail">
                            <div className="table-wrap">
                              <table>
                                <thead><tr><th>TC ID</th><th>Module</th><th>Input</th><th>Expected</th><th>Actual</th><th>Result</th><th>Confidence</th></tr></thead>
                                <tbody>
                                  {run.testCases.map(tc => {
                                    const r = run.results[tc.id];
                                    return (
                                      <tr key={tc.id} className={r?.pass ? "tc-row-pass" : r ? "tc-row-fail" : ""}>
                                        <td className="td-mono">{tc.id}</td>
                                        <td><span className="chip">{tc.module}</span></td>
                                        <td style={{ maxWidth: 180, color: "var(--text)", fontSize: 12 }}>{tc.input}</td>
                                        <td><span className="intent-pill">{tc.expectedIntent}</span></td>
                                        <td>{r ? <span className="intent-pill" style={{ background: r.intentMatch ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)", color: r.intentMatch ? "var(--accent3)" : "var(--danger)" }}>{r.actualIntent}</span> : "—"}</td>
                                        <td>{r ? <span className={`badge ${r.pass ? "badge-pass" : "badge-fail"}`}>{r.pass ? "PASS" : "FAIL"}</span> : <span className="badge badge-idle">N/A</span>}</td>
                                        <td className="td-mono">{r ? `${r.confidence}%` : "—"}</td>
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
      const resp = await fetch(`${config.backendUrl}/api/v1/process-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Brand": brand || "citroen" },
        body: JSON.stringify({
          text: userText, deviceId: `${config.deviceId}-${sessionId}`,
          language: config.language, model_name: config.modelName,
          user_timezone: config.timezone,
          latitude: parseFloat(config.latitude) || null,
          longitude: parseFloat(config.longitude) || null,
          include_tts: false,
        }),
      });
      const data = await resp.json();
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
