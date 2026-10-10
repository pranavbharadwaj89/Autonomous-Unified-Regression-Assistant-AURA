/**
 * PRISM — Multi-Model Comparison Panel
 *
 * Compares multiple LLM backends on:
 *   • Intent Accuracy  (pass rate per model)
 *   • Inference Latency (avg ms per query)
 *   • Token Cost       (estimated USD per query)
 *   • Language Coverage (accuracy across selected locales)
 *
 * Flow:
 *  1. User selects models + languages + test queries (manual or Excel import)
 *  2. Clicks "Run PRISM" → queries each model × language combination
 *  3. Dashboard shows side-by-side comparison table + metric bars
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { evaluateResult } from "../utils/evaluateTestResult.js";
import { downloadPrismAllureReport } from "../utils/generateAllureReport.js";
import { PIPELINE_OPT_IN } from "../config/pipelines.js";
import {
  evaluateAdvancedMetrics,
  METRIC_META,
  metricColor,
  hallucinationBadge,
  safetyBadge,
} from "../utils/evaluateAdvancedMetrics.js";
import {
  evaluateAgentMetrics,
  AGENT_METRIC_META,
  agentMetricColor,
} from "../utils/evaluateAgentMetrics.js";

// ── QA Runner base URL ─────────────────────────────────────────────────────────
const QA_RUNNER_BASE = "http://localhost:3001";

// ── Intent extraction from raw LLM content ────────────────────────────────────
// When PRISM calls models directly (not through CARA backend), the response is
// plain text. This heuristic maps keywords to CARA intents so evaluateResult
// can still score the result. If the expected intent appears in the response, it
// counts as a match.
function _extractIntentFromContent(content = "", expectedIntent = "") {
  if (!content) return "general_conversation";
  const c = content.toLowerCase();
  const PATTERNS = [
    [/navig|direction|route|map|turn-by-turn/,       "navigation"],
    [/weather|temperature|forecast|rain|cloud|sun/,  "get_current_weather"],
    [/remind|reminder|alarm|alert at/,               "time_based_reminder"],
    [/play|music|song|track|artist|playlist/,        "play_music"],
    [/call|phone|dial|ring/,                         "place_call"],
    [/time in |what time.*in |timezone/,             "get_time_in_location"],
    [/current time|what.*time.*now|local time/,      "get_locale_time"],
    [/flight|departure|arrival|boarding/,            "track_flight_status"],
    [/vehicle|car door|lock|unlock|window|trunk/,    "vehicle_command"],
    [/fuel|battery|tyre|odometer|vehicle status/,    "vehicle_status"],
    [/what can you do|help you|i can help|assistant/, "get_assistant_info"],
  ];
  for (const [re, intent] of PATTERNS) {
    if (re.test(c)) return intent;
  }
  if (expectedIntent && c.includes(expectedIntent.replace(/_/g, " "))) {
    return expectedIntent;
  }
  return "general_conversation";
}

// MODEL_CATALOGUE is now dynamically loaded from /prism/models (which reads
// .env.model1, .env.model2, … via dotenv_values — no hardcoded dummy models).
// This const is kept as a safe empty fallback only.
export const MODEL_CATALOGUE = [];

const LANGUAGE_OPTIONS = [
  // ── Indian Regional ──────────────────────────────────────────────────────────
  { code: "hi",  label: "Hindi",     group: "Indian" },
  { code: "ta",  label: "Tamil",     group: "Indian" },
  { code: "te",  label: "Telugu",    group: "Indian" },
  { code: "kn",  label: "Kannada",   group: "Indian" },
  { code: "ml",  label: "Malayalam", group: "Indian" },
  { code: "bn",  label: "Bengali",   group: "Indian" },
  { code: "mr",  label: "Marathi",   group: "Indian" },
  { code: "gu",  label: "Gujarati",  group: "Indian" },
  { code: "pa",  label: "Punjabi",   group: "Indian" },
  { code: "or",  label: "Odia",      group: "Indian" },
  { code: "as",  label: "Assamese",  group: "Indian" },
  { code: "ur",  label: "Urdu",      group: "Indian" },
  // ── International ────────────────────────────────────────────────────────────
  { code: "fr",  label: "French",     group: "International" },
  { code: "ja",  label: "Japanese",   group: "International" },
  { code: "es",  label: "Spanish",    group: "International" },
  { code: "zh",  label: "Mandarin",   group: "International" },
  { code: "ko",  label: "Korean",     group: "International" },
  { code: "pt",  label: "Portuguese", group: "International" },
];

// Rough token estimate: 1 token ≈ 4 chars
function estimateTokens(text) { return Math.max(1, Math.ceil((text || "").length / 4)); }

function estimateCost(model, inputText, outputText) {
  const inTok  = estimateTokens(inputText);
  const outTok = estimateTokens(outputText);
  return (inTok / 1000) * model.inputPer1k + (outTok / 1000) * model.outputPer1k;
}

// NOTE: PRISM benchmark uses POST /prism/run-compare (direct model calls only).
// It does NOT call CARA /process-text. Legacy runSingleQuery (process-text) removed
// to prevent accidental regression-agent chaining into PRISM.

// ── Utility: bar renderer ──────────────────────────────────────────────────────
function MetricBar({ value, max, color, label, unit = "" }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
      <div style={{ flex: 1, background: "rgba(255,255,255,0.06)", borderRadius: 3, height: 6, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, background: color, height: "100%", borderRadius: 3, transition: "width 0.4s" }} />
      </div>
      <span style={{ fontFamily: "var(--mono)", color: "var(--text2)", minWidth: 60, textAlign: "right" }}>
        {label}{unit}
      </span>
    </div>
  );
}

// ── Accuracy badge ─────────────────────────────────────────────────────────────
function AccBadge({ pct }) {
  const color = pct >= 80 ? "#10b981" : pct >= 55 ? "#f59e0b" : "#ef4444";
  return (
    <span style={{
      fontFamily: "var(--mono)", fontWeight: 700, fontSize: 15,
      color, padding: "2px 8px", borderRadius: 6,
      background: `${color}18`, border: `1px solid ${color}40`,
    }}>{pct}%</span>
  );
}

// ── Model selector card ────────────────────────────────────────────────────────
function ModelCard({ model, selected, onToggle, onEditCustom }) {
  return (
    <div
      onClick={() => onToggle(model.id)}
      style={{
        cursor: "pointer", userSelect: "none",
        padding: "10px 14px", borderRadius: 8,
        border: `1px solid ${selected ? model.color : "rgba(255,255,255,0.08)"}`,
        background: selected ? `${model.color}12` : "var(--surface2)",
        display: "flex", alignItems: "center", gap: 10, transition: "all 0.15s",
      }}
    >
      <div style={{
        width: 10, height: 10, borderRadius: "50%",
        background: selected ? model.color : "rgba(255,255,255,0.15)",
        flexShrink: 0, transition: "background 0.15s",
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: selected ? model.color : "var(--text)" }}>
          {model.name}
        </div>
        <div style={{ fontSize: 10, color: "var(--text3)" }}>{model.provider}</div>
      </div>
      {selected && model.id === "custom" && (
        <button
          onClick={e => { e.stopPropagation(); onEditCustom(); }}
          style={{ fontSize: 10, padding: "2px 6px", background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 4, color: "var(--text2)", cursor: "pointer" }}
        >Edit</button>
      )}
      <div style={{ fontSize: 9, fontFamily: "var(--mono)", color: "var(--text3)", textAlign: "right" }}>
        <div>${model.inputPer1k.toFixed(5)}/1k in</div>
        <div>${model.outputPer1k.toFixed(4)}/1k out</div>
      </div>
    </div>
  );
}

// ── Main PRISM component ──────────────────────────────────────────────────────
export default function PrismPanel({ config }) {
  // ── Dynamic model catalogue (loaded from .env.model* via qa-runner) ────────
  const [catalogue,       setCatalogue]      = useState([]);
  const [catalogueStatus, setCatalogueStatus] = useState("loading"); // "loading"|"ok"|"error"
  const [catalogueError,  setCatalogueError]  = useState("");

  useEffect(() => {
    fetch(`${QA_RUNNER_BASE}/prism/models`)
      .then(r => r.json())
      .then(d => {
        if (d.models && d.models.length > 0) {
          setCatalogue(d.models);
          // Auto-select all discovered models
          setSelectedModelIds(d.models.map(m => m.id));
          setCatalogueStatus("ok");
        } else {
          setCatalogueStatus("error");
          setCatalogueError("No .env.model* files found in qa-runner directory.");
        }
      })
      .catch(e => {
        setCatalogueStatus("error");
        setCatalogueError(`Could not reach qa-runner (${e.message}). Is it running on port 3001?`);
      });
  }, []);

  // ── Model / language selection ─────────────────────────────────────────────
  const [selectedModelIds, setSelectedModelIds] = useState([]);
  const [selectedLangs,    setSelectedLangs]    = useState(["hi", "en"]);

  // ── Query / test inputs ────────────────────────────────────────────────────
  const [queryMode,      setQueryMode]      = useState("manual");
  const [manualQueries,  setManualQueries]  = useState([
    { id: "q1", query: "How is the weather in Chennai?", expectedIntent: "get_current_weather" },
    { id: "q2", query: "Navigate to Marina Beach.",       expectedIntent: "navigation" },
    { id: "q3", query: "Remind me to call John at 3pm.",  expectedIntent: "time_based_reminder" },
  ]);
  const [excelQueries, setExcelQueries] = useState([]);
  const fileRef = useRef(null);

  // ── Run state ──────────────────────────────────────────────────────────────
  const [running,    setRunning]    = useState(false);
  const [progress,   setProgress]   = useState(0);
  const [results,    setResults]    = useState(null);
  const [statusMsg,  setStatusMsg]  = useState("");
  const abortRef = useRef(false);

  // ── Active view ────────────────────────────────────────────────────────────
  const [view, setView] = useState("summary");

  // ── Model ping / verification ──────────────────────────────────────────────
  const [pinging,    setPinging]    = useState(false);
  const [pingResult, setPingResult] = useState(null);
  const [pingError,  setPingError]  = useState("");

  // ── LLM Judge + manual overrides ──────────────────────────────────────────
  // Key format: `${modelId}||${lang}||${queryId}`
  const [judgments,   setJudgments]   = useState({}); // { key → { verdict, confidence, explanation, judging, error } }
  const [overrides,   setOverrides]   = useState({}); // { key → "correct" | "wrong" | null }
  const [judgingAll,  setJudgingAll]  = useState(false);
  const [judgeModel,  setJudgeModel]  = useState("gpt-4o-mini");
  // Explicit opt-in: benchmark never chains judge unless this is checked.
  const [optInJudgeAfterRun, setOptInJudgeAfterRun] = useState(false);
  const [lastBenchRaw,       setLastBenchRaw]       = useState(null);
  const [lastFlatQueries,    setLastFlatQueries]    = useState([]);

  /** Stable key for a single result cell */
  function judgeKey(modelId, lang, queryId) { return `${modelId}||${lang}||${queryId}`; }

  /**
   * Effective pass value for a single row, applying overrides → LLM judgment → heuristic
   * Precedence: manual override > LLM verdict > original heuristic
   */
  function effectivePass(row, modelId, lang) {
    const k = judgeKey(modelId, lang, row.queryId);
    const ov = overrides[k];
    if (ov === "correct") return true;
    if (ov === "wrong")   return false;
    const jv = judgments[k]?.verdict;
    if (jv === "correct")   return true;
    if (jv === "incorrect") return false;
    // "partial" or no judgment → fall back to heuristic
    return row.pass;
  }

  /** Call POST /prism/judge for one row; updates judgments state */
  async function judgeOne(row, modelId, lang, question, expectedIntent) {
    const k = judgeKey(modelId, lang, row.queryId);
    setJudgments(prev => ({ ...prev, [k]: { ...prev[k], judging: true } }));
    try {
      const resp = await fetch(`${QA_RUNNER_BASE}/prism/judge`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          question,
          expected_intent: expectedIntent,
          actual_response: row.message || "",
          judge_model:     judgeModel,
        }),
      });
      const data = await resp.json();
      setJudgments(prev => ({ ...prev, [k]: { ...data, judging: false } }));
    } catch (e) {
      setJudgments(prev => ({ ...prev, [k]: { verdict: "unknown", explanation: e.message, judging: false, error: e.message } }));
    }
  }

  /** Bulk judge — explicit only; uses POST /prism/judge-batch (never auto-fired). */
  async function judgeAll() {
    if (!lastBenchRaw || !lastFlatQueries.length) {
      alert("No benchmark results to judge. Run PRISM benchmark first.");
      return;
    }
    const ok = window.confirm(
      `Run LLM Judge on all ${lastFlatQueries.length} benchmark cells?\n\n` +
      `This will make one OpenAI call per cell via POST /prism/judge-batch.\n\nContinue?`
    );
    if (!ok) return;

    setJudgingAll(true);
    try {
      const resp = await fetch(`${QA_RUNNER_BASE}/prism/judge-batch`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          results:     lastBenchRaw,
          queries:     lastFlatQueries,
          judge_model: judgeModel,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const merged = {};
      for (const [k, v] of Object.entries(data.judgments || {})) {
        merged[k] = { ...v, judging: false };
      }
      setJudgments(merged);
    } catch (e) {
      alert(`Judge All failed: ${e.message}`);
    }
    setJudgingAll(false);
  }

  const queries = queryMode === "excel" ? excelQueries : manualQueries;

  // Active models = those selected AND present in the catalogue
  const models = catalogue.filter(m => selectedModelIds.includes(m.id));

  // ── Handlers ───────────────────────────────────────────────────────────────
  function toggleModel(id) {
    setSelectedModelIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  function toggleLang(code) {
    setSelectedLangs(prev =>
      prev.includes(code) ? prev.filter(x => x !== code) : [...prev, code]
    );
  }

  function addManualQuery() {
    const id = `q${Date.now()}`;
    setManualQueries(prev => [...prev, { id, query: "", expectedIntent: "get_live_data" }]);
  }

  function updateManualQuery(id, field, val) {
    setManualQueries(prev => prev.map(q => q.id === id ? { ...q, [field]: val } : q));
  }

  function removeManualQuery(id) {
    setManualQueries(prev => prev.filter(q => q.id !== id));
  }

  const handleExcelUpload = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      let XLSX = window.XLSX;
      if (!XLSX) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
          s.onload = () => { XLSX = window.XLSX; res(); };
          s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(buf, { type: "array" });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
      const headerIdx = rows.findIndex(r => r.some(c => String(c).trim() === "Test Case ID"));
      if (headerIdx === -1) throw new Error("No 'Test Case ID' column found");
      const headers = rows[headerIdx].map(h => String(h).trim());
      const inputCol = headers.indexOf("Voice Input (Prompt)");
      const intentCol = headers.indexOf("Expected Intent");
      const idCol = headers.indexOf("Test Case ID");
      const parsed = rows.slice(headerIdx + 1)
        .filter(r => r[idCol] && r[inputCol])
        .map((r, i) => ({
          id: String(r[idCol] || `q${i}`).trim(),
          query: String(r[inputCol] || "").trim(),
          expectedIntent: String(r[intentCol] || "general_conversation").trim(),
        }));
      setExcelQueries(parsed);
      setQueryMode("excel");
    } catch (err) {
      alert("Failed to parse Excel: " + err.message);
    }
    e.target.value = "";
  }, []);

  // ── Verify both models are reachable + fire together ──────────────────────
  async function verifyModels() {
    setPinging(true); setPingResult(null); setPingError("");
    try {
      const resp = await fetch(`${QA_RUNNER_BASE}/prism/ping-models`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setPingResult(data);
    } catch (e) {
      setPingError(e.message);
    }
    setPinging(false);
  }

  async function runPrism() {
    if (!queries.length || !models.length || !selectedLangs.length) return;
    setRunning(true); setResults(null); setProgress(0);
    abortRef.current = false;

    // Build a flat query list: one entry per (query × language) combination
    const flatQueries = [];
    for (const langCode of selectedLangs) {
      for (const q of queries) {
        flatQueries.push({
          id:               `${q.id}_${langCode}`,
          text:             q.query,
          language:         langCode,
          expectedIntent:   q.expectedIntent  || "",
          expectedResponse: q.expectedResponse || "",
        });
      }
    }

    setStatusMsg(`Running ${models.length} models × ${flatQueries.length} queries in parallel…`);

    let benchResult;
    try {
      const resp = await fetch(`${QA_RUNNER_BASE}/prism/run-compare`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          queries:     flatQueries,
          env_files:   null,
          [PIPELINE_OPT_IN.PRISM_WITH_JUDGE]: optInJudgeAfterRun,
          judge_model: judgeModel,
        }),
      });
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({}));
        throw new Error(detail.detail || `HTTP ${resp.status}`);
      }
      benchResult = await resp.json();
      setProgress(100);
    } catch (e) {
      setRunning(false);
      setStatusMsg(`Run failed: ${e.message}`);
      return;
    }

    // Re-shape backend results into the format the UI expects:
    // { [modelId]: { [langCode]: [ ...resultRows ] } }
    const out = {};
    for (const model of models) {
      out[model.id] = {};
      for (const langCode of selectedLangs) {
        out[model.id][langCode] = [];
      }
    }

    const modelResults = benchResult.results || {};
    for (const [modelId, queryMap] of Object.entries(modelResults)) {
      if (!out[modelId]) continue;
      for (const [flatId, raw] of Object.entries(queryMap)) {
        // flatId = "<queryId>_<langCode>"
        const parts    = flatId.split("_");
        const langCode = parts[parts.length - 1];
        const qId      = parts.slice(0, -1).join("_");
        const q        = queries.find(x => x.id === qId) || { query: "", expectedIntent: "" };

        if (!out[modelId][langCode]) continue;

        // Client-side intent + quality evaluation (same evaluators as before)
        const fakeData = {
          intent: raw.error ? "error" : _extractIntentFromContent(raw.content, q.expectedIntent),
          type:   "general_conversation",
          assistant: { message: raw.content || "" },
        };
        const tc        = { id: flatId, module: "", input: q.query, expectedIntent: q.expectedIntent };
        const evResult  = evaluateResult(fakeData, tc);
        const modelMeta = catalogue.find(m => m.id === modelId) || {};

        const advMetrics = evaluateAdvancedMetrics({
          actualResponse:   raw.content || "",
          expectedResponse: q.expectedResponse || "",
          query:            q.query,
        });
        const agentMetrics = evaluateAgentMetrics({
          actualResponse:   raw.content || "",
          query:            q.query,
          evResult,
          toolCheck:        evResult.toolCheck || null,
          isMultiTurn:      false,
          turnNo:           1,
          hasSessionContext: false,
        });

        out[modelId][langCode].push({
          model:              modelId,
          lang:               langCode,
          query:              q.query,
          queryId:            qId,
          queryText:          q.query,
          expectedIntent:     q.expectedIntent,
          pass:               !raw.error && evResult.pass,
          confidence:         evResult.confidence,
          actualIntent:       evResult.actualIntent,
          matchSource:        evResult.matchSource,
          message:            raw.content || "",
          latency:            raw.latency_ms || 0,
          cost:               raw.cost_usd   || 0,
          inTok:              raw.prompt_tokens     || 0,
          outTok:             raw.completion_tokens || 0,
          error:              raw.error || null,
          // Advanced quality
          responseAccuracy:   advMetrics.responseAccuracy,
          hallucinationScore: advMetrics.hallucinationScore,
          hallucinationLevel: advMetrics.hallucinationLevel,
          hallucinationFlags: advMetrics.hallucinationFlags,
          faithfulnessScore:  advMetrics.faithfulnessScore,
          completenessScore:  advMetrics.completenessScore,
          safetyScore:        advMetrics.safetyScore,
          safetyPassed:       advMetrics.safetyPassed,
          safetyFlags:        advMetrics.safetyFlags,
          overallQuality:     advMetrics.overallQuality,
          // E2E Agent
          reasoningScore:      agentMetrics.reasoningScore,
          toolSelectionScore:  agentMetrics.toolSelectionScore,
          toolExecutionScore:  agentMetrics.toolExecutionScore,
          memoryScore:         agentMetrics.memoryScore,
          taskCompletionScore: agentMetrics.taskCompletionScore,
        });
      }
    }

    const finalResults = { ...out };
    setResults(finalResults);
    setLastBenchRaw(benchResult.results || null);
    setLastFlatQueries(flatQueries);
    if (benchResult.judgments) {
      const merged = {};
      for (const [k, v] of Object.entries(benchResult.judgments)) {
        merged[k] = { ...v, judging: false };
      }
      setJudgments(merged);
    }
    setRunning(false);
    setStatusMsg(`Completed in ${benchResult.elapsed_s}s · ${benchResult.model_count} models · ${benchResult.query_count} queries`);
    setView("summary");

    // Auto-save to PostgreSQL via QA Runner (best-effort)
    import("../api/caraBackend.js").then(({ savePrismRunToDB }) => {
      savePrismRunToDB({
        results:      finalResults,
        models,
        queries,
        selectedLangs,
        projectName:  "CARA",
        backendUrl:   config?.backendUrl,
      }).then(() => console.log("[PRISM] Run saved to DB"))
        .catch(err  => console.warn("[PRISM] DB save skipped:", err.message));
    });
  }

  // ── Computed metrics ───────────────────────────────────────────────────────
  function avgNonNull(rows, key) {
    const vals = rows.map(r => r[key]).filter(v => v !== null && v !== undefined);
    return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  }

  function modelSummary(modelId) {
    if (!results?.[modelId]) return null;
    let totalTests = 0, totalPass = 0, totalLatency = 0, totalCost = 0;
    const langAcc = {};
    const allRows = [];

    for (const [lang, rows] of Object.entries(results[modelId])) {
      // Use effectivePass so overrides + LLM judgments propagate to the summary
      const pass = rows.filter(r => effectivePass(r, modelId, lang)).length;
      langAcc[lang] = rows.length > 0 ? Math.round((pass / rows.length) * 100) : 0;
      totalTests   += rows.length;
      totalPass    += pass;
      totalLatency += rows.reduce((s, r) => s + (r.latency || 0), 0);
      totalCost    += rows.reduce((s, r) => s + (r.cost || 0), 0);
      allRows.push(...rows);
    }

    return {
      accuracy:           totalTests > 0 ? Math.round((totalPass / totalTests) * 100) : 0,
      avgLatency:         totalTests > 0 ? Math.round(totalLatency / totalTests)       : 0,
      totalCost,
      avgCost:            totalTests > 0 ? totalCost / totalTests : 0,
      langAcc,
      totalTests,
      totalPass,
      // Advanced quality metric averages
      avgResponseAccuracy:   avgNonNull(allRows, "responseAccuracy"),
      avgHallucinationScore: avgNonNull(allRows, "hallucinationScore"),
      avgFaithfulness:       avgNonNull(allRows, "faithfulnessScore"),
      avgCompleteness:       avgNonNull(allRows, "completenessScore"),
      avgSafetyScore:        avgNonNull(allRows, "safetyScore"),
      avgOverallQuality:     avgNonNull(allRows, "overallQuality"),
      unsafeCount:           allRows.filter(r => !r.safetyPassed).length,
      highHalluCount:        allRows.filter(r => r.hallucinationLevel === "high" || r.hallucinationLevel === "medium").length,
      // E2E Agent metric averages
      avgReasoning:       avgNonNull(allRows, "reasoningScore"),
      avgToolSelection:   avgNonNull(allRows, "toolSelectionScore"),
      avgToolExecution:   avgNonNull(allRows, "toolExecutionScore"),
      avgMemory:          avgNonNull(allRows, "memoryScore"),
      avgTaskCompletion:  avgNonNull(allRows, "taskCompletionScore"),
    };
  }

  const summaries  = results ? models.map(m => ({ model: m, ...modelSummary(m.id) })) : [];
  const maxLatency = summaries.length ? Math.max(...summaries.map(s => s.avgLatency || 0)) : 1;
  const maxCost    = summaries.length ? Math.max(...summaries.map(s => s.avgCost || 0))    : 0.001;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="prism-root">

      {/* ── Config panel ── */}
      <div className="prism-config-grid">

        {/* Models — loaded from .env.model* files via qa-runner /prism/models */}
        <div className="prism-card">
          <div className="prism-card-title">
            <span className="prism-icon">◈</span> Models
            <span className="prism-hint">{selectedModelIds.length} / {catalogue.length} selected</span>
            <span style={{ marginLeft: "auto", fontSize: 9, padding: "1px 6px", borderRadius: 3,
              background: catalogueStatus === "ok" ? "rgba(16,185,129,0.15)" : catalogueStatus === "loading" ? "rgba(245,158,11,0.15)" : "rgba(239,68,68,0.15)",
              color: catalogueStatus === "ok" ? "var(--accent3)" : catalogueStatus === "loading" ? "#f59e0b" : "#ef4444",
              border: `1px solid ${catalogueStatus === "ok" ? "rgba(16,185,129,0.3)" : catalogueStatus === "loading" ? "rgba(245,158,11,0.3)" : "rgba(239,68,68,0.3)"}`,
            }}>
              {catalogueStatus === "ok" ? `${catalogue.length} from .env.model*` : catalogueStatus === "loading" ? "loading…" : "offline"}
            </span>
          </div>

          {catalogueStatus === "error" && (
            <div style={{ fontSize: 11, color: "#ef4444", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "8px 12px", marginBottom: 10 }}>
              ⚠ {catalogueError}
              <div style={{ marginTop: 4, color: "var(--text3)" }}>Create <code>.env.model1</code> and <code>.env.model2</code> in the <code>qa-runner/</code> folder, then restart the qa-runner.</div>
            </div>
          )}

          {catalogueStatus === "loading" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 0", color: "var(--text3)", fontSize: 12 }}>
              <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Fetching models from qa-runner…
            </div>
          )}

          <div className="prism-model-grid">
            {catalogue.map(m => (
              <ModelCard
                key={m.id}
                model={m}
                selected={selectedModelIds.includes(m.id)}
                onToggle={toggleModel}
                onEditCustom={() => {}}
              />
            ))}
          </div>
        </div>

        {/* Languages */}
        <div className="prism-card" style={{ gridRow: "span 1" }}>
          <div className="prism-card-title">
            <span className="prism-icon">⊕</span> Languages
            <span className="prism-hint">{selectedLangs.length} selected</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button
                onClick={() => setSelectedLangs(LANGUAGE_OPTIONS.filter(l => l.group === "Indian").map(l => l.code))}
                style={{ fontSize: 9, padding: "2px 7px", background: "rgba(124,58,237,0.15)", border: "1px solid rgba(124,58,237,0.3)", borderRadius: 4, color: "#a78bfa", cursor: "pointer" }}
              >All Indian</button>
              <button
                onClick={() => setSelectedLangs(LANGUAGE_OPTIONS.filter(l => l.group === "International").map(l => l.code))}
                style={{ fontSize: 9, padding: "2px 7px", background: "rgba(0,229,255,0.1)", border: "1px solid rgba(0,229,255,0.25)", borderRadius: 4, color: "var(--accent)", cursor: "pointer" }}
              >All Intl</button>
              <button
                onClick={() => setSelectedLangs(LANGUAGE_OPTIONS.map(l => l.code))}
                style={{ fontSize: 9, padding: "2px 7px", background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.25)", borderRadius: 4, color: "var(--accent3)", cursor: "pointer" }}
              >All</button>
              <button
                onClick={() => setSelectedLangs([])}
                style={{ fontSize: 9, padding: "2px 7px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "var(--text3)", cursor: "pointer" }}
              >None</button>
            </div>
          </div>

          {/* Indian Regional */}
          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 9, color: "#a78bfa", fontFamily: "var(--mono)", letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: 7, paddingLeft: 2 }}>
              🇮🇳 Indian Regional
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {LANGUAGE_OPTIONS.filter(l => l.group === "Indian").map(l => (
                <button
                  key={l.code}
                  onClick={() => toggleLang(l.code)}
                  style={{
                    padding: "4px 11px", borderRadius: 20, fontSize: 11, cursor: "pointer",
                    border: `1px solid ${selectedLangs.includes(l.code) ? "#a78bfa" : "rgba(255,255,255,0.1)"}`,
                    background: selectedLangs.includes(l.code) ? "rgba(124,58,237,0.15)" : "var(--surface2)",
                    color: selectedLangs.includes(l.code) ? "#c4b5fd" : "var(--text2)",
                    transition: "all 0.15s",
                  }}
                >{l.label}</button>
              ))}
            </div>
          </div>

          {/* International */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 9, color: "var(--accent)", fontFamily: "var(--mono)", letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: 7, paddingLeft: 2 }}>
              🌐 International
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {LANGUAGE_OPTIONS.filter(l => l.group === "International").map(l => (
                <button
                  key={l.code}
                  onClick={() => toggleLang(l.code)}
                  style={{
                    padding: "4px 11px", borderRadius: 20, fontSize: 11, cursor: "pointer",
                    border: `1px solid ${selectedLangs.includes(l.code) ? "var(--accent)" : "rgba(255,255,255,0.1)"}`,
                    background: selectedLangs.includes(l.code) ? "rgba(0,229,255,0.1)" : "var(--surface2)",
                    color: selectedLangs.includes(l.code) ? "var(--accent)" : "var(--text2)",
                    transition: "all 0.15s",
                  }}
                >{l.label}</button>
              ))}
            </div>
          </div>

          {/* Query mode toggle */}
          <div style={{ marginTop: 20 }}>
            <div className="prism-card-title" style={{ marginBottom: 10 }}>
              <span className="prism-icon">≡</span> Test Queries
              <span className="prism-hint">{queries.length} queries</span>
              <button
                onClick={() => fileRef.current?.click()}
                style={{ marginLeft: "auto", fontSize: 10, padding: "3px 8px", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 4, color: "var(--text2)", cursor: "pointer" }}
              >↑ Import Excel</button>
              <input ref={fileRef} type="file" accept=".xlsx" style={{ display: "none" }} onChange={handleExcelUpload} />
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {["manual", "excel"].map(m => (
                <button
                  key={m}
                  onClick={() => setQueryMode(m)}
                  style={{
                    fontSize: 11, padding: "4px 10px", borderRadius: 4, cursor: "pointer",
                    border: `1px solid ${queryMode === m ? "var(--accent)" : "rgba(255,255,255,0.1)"}`,
                    background: queryMode === m ? "rgba(0,229,255,0.08)" : "var(--surface2)",
                    color: queryMode === m ? "var(--accent)" : "var(--text3)",
                  }}
                >{m === "manual" ? "Manual" : `Excel (${excelQueries.length})`}</button>
              ))}
            </div>

            {queryMode === "manual" && (
              <div className="prism-query-list">
                {manualQueries.map(q => (
                  <div key={q.id} className="prism-query-row">
                    <input
                      className="prism-input"
                      placeholder="Enter query…"
                      value={q.query}
                      onChange={e => updateManualQuery(q.id, "query", e.target.value)}
                      style={{ flex: 2 }}
                    />
                    <input
                      className="prism-input"
                      placeholder="Expected intent"
                      value={q.expectedIntent}
                      onChange={e => updateManualQuery(q.id, "expectedIntent", e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      onClick={() => removeManualQuery(q.id)}
                      style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 14, padding: "0 4px", flexShrink: 0 }}
                    >✕</button>
                  </div>
                ))}
                <button
                  onClick={addManualQuery}
                  style={{ marginTop: 6, fontSize: 11, padding: "4px 10px", background: "rgba(255,255,255,0.05)", border: "1px dashed rgba(255,255,255,0.15)", borderRadius: 4, color: "var(--text3)", cursor: "pointer" }}
                >+ Add query</button>
              </div>
            )}

            {queryMode === "excel" && excelQueries.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--text3)", padding: "6px 0" }}>
                {excelQueries.length} queries loaded · first: "{excelQueries[0]?.query?.slice(0, 60)}…"
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Ping result card ── */}
      {(pingResult || pingError) && (
        <div style={{
          background: "var(--surface2)", border: `1px solid ${pingError ? "rgba(239,68,68,0.3)" : "rgba(16,185,129,0.25)"}`,
          borderRadius: 10, padding: "14px 18px", marginBottom: 4,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: pingError ? "#ef4444" : "var(--accent3)" }}>
              {pingError ? "⚠ Model Verification Failed" : "✅ Both Models Verified — Running in Parallel"}
            </div>
            {pingResult && (
              <span style={{ fontSize: 11, color: "var(--text3)" }}>
                Total wall time: <strong>{pingResult.total_elapsed_ms}ms</strong>
              </span>
            )}
            <button style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 14 }} onClick={() => { setPingResult(null); setPingError(""); }}>✕</button>
          </div>

          {pingError && <div style={{ fontSize: 12, color: "#ef4444" }}>{pingError}</div>}

          {pingResult?.pings && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {pingResult.pings.map(p => (
                <div key={p.model} style={{
                  background: p.error ? "rgba(239,68,68,0.06)" : "rgba(16,185,129,0.04)",
                  border: `1px solid ${p.error ? "rgba(239,68,68,0.2)" : "rgba(16,185,129,0.15)"}`,
                  borderRadius: 8, padding: "10px 14px",
                }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 6 }}>
                    <strong style={{ fontSize: 12, color: "var(--text)" }}>{p.display_name}</strong>
                    <span style={{ fontSize: 10, color: "var(--text3)" }}>{p.env_file}</span>
                    <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--accent3)", marginLeft: "auto" }}>
                      started +{p.started_ms_offset}ms · done +{p.completed_ms_offset}ms · latency {p.latency_ms}ms
                    </span>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 4,
                      background: p.error ? "rgba(239,68,68,0.15)" : "rgba(16,185,129,0.15)",
                      color: p.error ? "#ef4444" : "#10b981",
                    }}>{p.error ? "ERROR" : "OK"}</span>
                  </div>
                  {p.error
                    ? <div style={{ fontSize: 11, color: "#ef4444", fontFamily: "var(--mono)" }}>{p.error}</div>
                    : <div style={{ fontSize: 11, color: "var(--text3)", fontStyle: "italic", lineHeight: 1.5 }}>"{p.response}"</div>
                  }
                </div>
              ))}
              <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>
                💡 {pingResult.note}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Run bar ── */}
      <div className="prism-run-bar">
        <div style={{ fontSize: 12, color: "var(--text3)" }}>
          {running
            ? <><span className="prism-pulse" />Running: {statusMsg}</>
            : <>
                {models.length} model{models.length !== 1 ? "s" : ""} × {selectedLangs.length} lang{selectedLangs.length !== 1 ? "s" : ""} × {queries.length} quer{queries.length !== 1 ? "ies" : "y"} = {models.length * selectedLangs.length * queries.length} calls
                <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text3)" }}>
                  (benchmark only — Verify / Judge are separate)
                </span>
              </>
          }
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {!running && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text3)", cursor: "pointer" }} title="Opt-in: chain LLM judge after benchmark completes (with_judge=true)">
              <input
                type="checkbox"
                checked={optInJudgeAfterRun}
                onChange={e => setOptInJudgeAfterRun(e.target.checked)}
                style={{ accentColor: "var(--accent)" }}
              />
              with_judge
            </label>
          )}
          {running && (
            <div className="prism-progress-wrap">
              <div className="prism-progress-bar" style={{ width: `${progress}%` }} />
            </div>
          )}
          {running ? (
            <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={() => { abortRef.current = true; }}>■ Stop</button>
          ) : (
            <>
              <button
                className="btn btn-secondary"
                style={{ fontSize: 12 }}
                disabled={pinging || !models.length}
                onClick={verifyModels}
                title="Fire a single ping to both models to confirm parallel execution before a full run"
              >
                {pinging ? "Pinging…" : "🔍 Verify Models"}
              </button>
              <button
                className="btn btn-primary"
                disabled={!queries.length || !models.length || !selectedLangs.length}
                onClick={runPrism}
              >▶ Run PRISM</button>
            </>
          )}
        </div>
      </div>

      {/* ── Results ── */}
      {results && (
        <div className="prism-results">

          {/* View tabs */}
          <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
            {[
              ["summary", "Summary"],
              ["detail",  "Per-Query Detail"],
              ["lang",    "Language Breakdown"],
              ["quality", "Quality Metrics"],
              ["raw",     "Raw Responses"],
            ].map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  fontSize: 12, padding: "5px 14px", borderRadius: 6, cursor: "pointer",
                  border:     `1px solid ${view === v ? "var(--accent)" : "rgba(255,255,255,0.1)"}`,
                  background: view === v ? "rgba(0,229,255,0.08)" : "transparent",
                  color:      view === v ? "var(--accent)" : "var(--text3)",
                }}
              >
                {label}
                {v === "quality" && (
                  <span style={{ marginLeft: 5, fontSize: 9, background: "rgba(124,58,237,0.25)", color: "#a78bfa", padding: "1px 5px", borderRadius: 10, border: "1px solid rgba(124,58,237,0.4)" }}>NEW</span>
                )}
              </button>
            ))}
          </div>

          {/* ── Summary view ── */}
          {view === "summary" && (
            <div className="prism-summary-grid">
              {summaries.map((s) => {
                const { model, accuracy, avgLatency, avgCost, totalTests, totalPass,
                        avgResponseAccuracy, avgHallucinationScore, avgFaithfulness,
                        avgCompleteness, avgSafetyScore, avgOverallQuality,
                        unsafeCount, highHalluCount,
                        avgReasoning, avgToolSelection, avgToolExecution,
                        avgMemory, avgTaskCompletion } = s;
                return (
                  <div key={model.id} className="prism-summary-card" style={{ borderColor: `${model.color}40` }}>

                    {/* Header */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: model.color }}>{model.name}</div>
                        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{model.provider}</div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                        <AccBadge pct={accuracy} />
                        {avgOverallQuality !== null && (
                          <span style={{ fontSize: 10, color: metricColor(avgOverallQuality), fontFamily: "var(--mono)", fontWeight: 600 }}>
                            Q: {avgOverallQuality}%
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Core perf metrics */}
                    <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: 6, fontFamily: "var(--mono)" }}>Performance</div>
                    <div className="prism-metric-rows">
                      <div className="prism-metric-label">Intent Accuracy</div>
                      <MetricBar value={accuracy} max={100} color={model.color} label={`${accuracy}`} unit="%" />

                      <div className="prism-metric-label" style={{ marginTop: 8 }}>Avg Latency</div>
                      <MetricBar value={avgLatency} max={maxLatency || 1} color="#f59e0b" label={`${avgLatency}`} unit=" ms" />

                      <div className="prism-metric-label" style={{ marginTop: 8 }}>Avg Cost / Query</div>
                      <MetricBar value={avgCost} max={maxCost || 0.001} color="#7c3aed" label={`$${avgCost.toFixed(5)}`} />
                    </div>

                    {/* Divider */}
                    <div style={{ margin: "12px 0 10px", borderTop: "1px solid rgba(255,255,255,0.06)" }} />

                    {/* Quality metrics */}
                    <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: 6, fontFamily: "var(--mono)" }}>Response Quality</div>
                    <div className="prism-metric-rows">
                      {avgResponseAccuracy !== null && (<>
                        <div className="prism-metric-label">Resp. Accuracy</div>
                        <MetricBar value={avgResponseAccuracy} max={100} color={metricColor(avgResponseAccuracy)} label={`${avgResponseAccuracy}`} unit="%" />
                      </>)}
                      {avgFaithfulness !== null && (<>
                        <div className="prism-metric-label" style={{ marginTop: 8 }}>Faithfulness</div>
                        <MetricBar value={avgFaithfulness} max={100} color={metricColor(avgFaithfulness)} label={`${avgFaithfulness}`} unit="%" />
                      </>)}
                      {avgCompleteness !== null && (<>
                        <div className="prism-metric-label" style={{ marginTop: 8 }}>Completeness</div>
                        <MetricBar value={avgCompleteness} max={100} color={metricColor(avgCompleteness)} label={`${avgCompleteness}`} unit="%" />
                      </>)}
                    </div>

                    {/* Divider */}
                    <div style={{ margin: "12px 0 10px", borderTop: "1px solid rgba(255,255,255,0.06)" }} />

                    {/* Risk metrics */}
                    <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: 6, fontFamily: "var(--mono)" }}>Risk & Safety</div>
                    <div className="prism-metric-rows">
                      {avgHallucinationScore !== null && (<>
                        <div className="prism-metric-label">Anti-Halluc.</div>
                        <MetricBar value={avgHallucinationScore} max={100} color={metricColor(avgHallucinationScore)} label={`${avgHallucinationScore}`} unit="%" />
                      </>)}
                      {avgSafetyScore !== null && (<>
                        <div className="prism-metric-label" style={{ marginTop: 8 }}>Safety</div>
                        <MetricBar value={avgSafetyScore} max={100} color={metricColor(avgSafetyScore)} label={`${avgSafetyScore}`} unit="%" />
                      </>)}
                    </div>

                    {/* Divider */}
                    <div style={{ margin: "12px 0 10px", borderTop: "1px solid rgba(255,255,255,0.06)" }} />

                    {/* E2E Agent metrics */}
                    <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: 6, fontFamily: "var(--mono)", display: "flex", alignItems: "center", gap: 6 }}>
                      E2E Agent Eval
                      <span style={{ fontSize: 8, background: "rgba(0,229,255,0.15)", color: "var(--accent)", padding: "1px 5px", borderRadius: 8, border: "1px solid rgba(0,229,255,0.3)", letterSpacing: "0.5px" }}>NEW</span>
                    </div>
                    <div className="prism-metric-rows">
                      {avgTaskCompletion !== null && (<>
                        <div className="prism-metric-label" style={{ color: AGENT_METRIC_META.taskCompletionScore.color }}>Task Completion</div>
                        <MetricBar value={avgTaskCompletion} max={100} color={AGENT_METRIC_META.taskCompletionScore.color} label={`${avgTaskCompletion}`} unit="%" />
                      </>)}
                      {avgReasoning !== null && (<>
                        <div className="prism-metric-label" style={{ marginTop: 8, color: AGENT_METRIC_META.reasoningScore.color }}>Reasoning</div>
                        <MetricBar value={avgReasoning} max={100} color={AGENT_METRIC_META.reasoningScore.color} label={`${avgReasoning}`} unit="%" />
                      </>)}
                      {avgToolSelection !== null && (<>
                        <div className="prism-metric-label" style={{ marginTop: 8, color: AGENT_METRIC_META.toolSelectionScore.color }}>Tool Selection</div>
                        <MetricBar value={avgToolSelection} max={100} color={AGENT_METRIC_META.toolSelectionScore.color} label={`${avgToolSelection}`} unit="%" />
                      </>)}
                      {avgToolExecution !== null && (<>
                        <div className="prism-metric-label" style={{ marginTop: 8, color: AGENT_METRIC_META.toolExecutionScore.color }}>Tool Execution</div>
                        <MetricBar value={avgToolExecution} max={100} color={AGENT_METRIC_META.toolExecutionScore.color} label={`${avgToolExecution}`} unit="%" />
                      </>)}
                      {avgMemory !== null && (<>
                        <div className="prism-metric-label" style={{ marginTop: 8, color: AGENT_METRIC_META.memoryScore.color }}>Memory Use</div>
                        <MetricBar value={avgMemory} max={100} color={AGENT_METRIC_META.memoryScore.color} label={`${avgMemory}`} unit="%" />
                      </>)}
                    </div>

                    {/* Footer stats */}
                    <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", flexWrap: "wrap", gap: 12 }}>
                      <div><div style={{ fontSize: 10, color: "var(--text3)" }}>Tests</div><div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", fontFamily: "var(--mono)" }}>{totalTests}</div></div>
                      <div><div style={{ fontSize: 10, color: "var(--text3)" }}>Pass</div><div style={{ fontSize: 15, fontWeight: 700, color: "#10b981", fontFamily: "var(--mono)" }}>{totalPass}</div></div>
                      <div><div style={{ fontSize: 10, color: "var(--text3)" }}>Fail</div><div style={{ fontSize: 15, fontWeight: 700, color: "#ef4444", fontFamily: "var(--mono)" }}>{totalTests - totalPass}</div></div>
                      {unsafeCount > 0 && (
                        <div><div style={{ fontSize: 10, color: "#ef4444" }}>⛨ Unsafe</div><div style={{ fontSize: 15, fontWeight: 700, color: "#ef4444", fontFamily: "var(--mono)" }}>{unsafeCount}</div></div>
                      )}
                      {highHalluCount > 0 && (
                        <div><div style={{ fontSize: 10, color: "#f97316" }}>⚠ Halluc.</div><div style={{ fontSize: 15, fontWeight: 700, color: "#f97316", fontFamily: "var(--mono)" }}>{highHalluCount}</div></div>
                      )}
                      <div style={{ marginLeft: "auto", textAlign: "right" }}>
                        <div style={{ fontSize: 10, color: "var(--text3)" }}>Total Cost</div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text2)", fontFamily: "var(--mono)" }}>${s.totalCost?.toFixed(4)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Detail view ── */}
          {view === "detail" && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Query</th>
                    <th>Expected Intent</th>
                    <th>Language</th>
                    {models.map(m => (
                      <th key={m.id} style={{ color: m.color }}>{m.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queries.map(q =>
                    selectedLangs.map(lang => (
                      <tr key={`${q.id}-${lang}`}>
                        <td style={{ maxWidth: 220, fontSize: 11 }}>{q.query}</td>
                        <td><span className="intent-pill">{q.expectedIntent}</span></td>
                        <td style={{ fontSize: 11 }}>{LANGUAGE_OPTIONS.find(l => l.code === lang)?.label || lang}</td>
                        {models.map(m => {
                          const r = results[m.id]?.[lang]?.find(x => x.queryId === q.id);
                          if (!r) return <td key={m.id} style={{ color: "var(--text3)" }}>—</td>;
                          const hBadge = hallucinationBadge(r.hallucinationLevel);
                          const sBadge = safetyBadge(r.safetyPassed, r.safetyFlags || []);
                          return (
                            <td key={m.id}>
                              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                {/* Intent pass/fail */}
                                <span className={`badge ${r.pass ? "badge-pass" : "badge-fail"}`} style={{ fontSize: 9 }}>
                                  {r.pass ? "PASS" : "FAIL"}
                                </span>
                                {/* Perf */}
                                <span style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)" }}>{r.latency}ms · ${r.cost?.toFixed(5)}</span>
                                {/* Quality mini-badges */}
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 2 }}>
                                  {r.responseAccuracy !== null && (
                                    <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: metricColor(r.responseAccuracy), background: `${metricColor(r.responseAccuracy)}18`, padding: "1px 5px", borderRadius: 4, border: `1px solid ${metricColor(r.responseAccuracy)}30` }}>
                                      RA:{r.responseAccuracy}%
                                    </span>
                                  )}
                                  {r.completenessScore !== null && (
                                    <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: metricColor(r.completenessScore), background: `${metricColor(r.completenessScore)}18`, padding: "1px 5px", borderRadius: 4, border: `1px solid ${metricColor(r.completenessScore)}30` }}>
                                      C:{r.completenessScore}%
                                    </span>
                                  )}
                                  <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: hBadge.color, background: `${hBadge.color}18`, padding: "1px 5px", borderRadius: 4, border: `1px solid ${hBadge.color}30` }}>
                                    H:{hBadge.label}
                                  </span>
                                  <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: sBadge.color, background: `${sBadge.color}18`, padding: "1px 5px", borderRadius: 4, border: `1px solid ${sBadge.color}30` }}>
                                    {sBadge.label}
                                  </span>
                                </div>
                                {/* E2E Agent mini-badges */}
                                {r.taskCompletionScore !== null && r.taskCompletionScore !== undefined && (
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 3, paddingTop: 3, borderTop: "1px solid rgba(249,115,22,0.15)" }}>
                                    {r.taskCompletionScore !== null && (
                                      <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: agentMetricColor(r.taskCompletionScore), background: `${agentMetricColor(r.taskCompletionScore)}18`, padding: "1px 5px", borderRadius: 4, border: `1px solid ${agentMetricColor(r.taskCompletionScore)}30`, fontWeight: 700 }}>
                                        ★{r.taskCompletionScore}%
                                      </span>
                                    )}
                                    {r.reasoningScore !== null && (
                                      <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: "#00e5ff", background: "rgba(0,229,255,0.08)", padding: "1px 5px", borderRadius: 4, border: "1px solid rgba(0,229,255,0.2)" }}>
                                        🧠{r.reasoningScore}%
                                      </span>
                                    )}
                                    {r.toolSelectionScore !== null && (
                                      <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: agentMetricColor(r.toolSelectionScore), background: "rgba(167,139,250,0.08)", padding: "1px 5px", borderRadius: 4, border: "1px solid rgba(167,139,250,0.2)" }}>
                                        ⚙{r.toolSelectionScore}%
                                      </span>
                                    )}
                                    {r.toolExecutionScore !== null && (
                                      <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: agentMetricColor(r.toolExecutionScore), background: "rgba(16,185,129,0.08)", padding: "1px 5px", borderRadius: 4, border: "1px solid rgba(16,185,129,0.2)" }}>
                                        ✓{r.toolExecutionScore}%
                                      </span>
                                    )}
                                  </div>
                                )}
                                {r.error && <span style={{ fontSize: 9, color: "var(--danger)" }}>{r.error}</span>}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Language breakdown view ── */}
          {view === "lang" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

              {/* Legend */}
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                {models.map(m => (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: m.color }} />
                    <span style={{ fontSize: 12, color: m.color, fontWeight: 600 }}>{m.name}</span>
                  </div>
                ))}
                <div style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 11, color: "var(--text3)" }}>
                  <span>🎯 Accuracy</span>
                  <span>⚡ Avg Latency</span>
                  <span>💰 Cost / prompt</span>
                </div>
              </div>

              {/* One row-card per language */}
              {selectedLangs.map(lang => {
                const langLabel = LANGUAGE_OPTIONS.find(l => l.code === lang)?.label || lang.toUpperCase();
                return (
                  <div key={lang} style={{
                    background: "var(--surface2)",
                    border: "1px solid var(--surface3)",
                    borderRadius: 12,
                    overflow: "hidden",
                  }}>
                    {/* Language header */}
                    <div style={{
                      padding: "10px 18px",
                      borderBottom: "1px solid var(--surface3)",
                      display: "flex", alignItems: "center", gap: 12,
                      background: "rgba(255,255,255,0.02)",
                    }}>
                      <span style={{ fontSize: 18 }}>
                        {/* flag emoji based on language */}
                        {({
                          en:"🇬🇧", hi:"🇮🇳", ta:"🇮🇳", te:"🇮🇳", kn:"🇮🇳", ml:"🇮🇳",
                          mr:"🇮🇳", gu:"🇮🇳", pa:"🇮🇳", bn:"🇮🇳", or:"🇮🇳",
                          fr:"🇫🇷", de:"🇩🇪", es:"🇪🇸", ja:"🇯🇵", zh:"🇨🇳",
                          ko:"🇰🇷", pt:"🇵🇹", ar:"🇸🇦", it:"🇮🇹",
                        })[lang] || "🌐"}
                      </span>
                      <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{langLabel}</span>
                      <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text3)", padding: "2px 7px", background: "rgba(255,255,255,0.05)", borderRadius: 4 }}>{lang}</span>
                    </div>

                    {/* Model metric cells — one per model */}
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: `repeat(${Math.max(models.length, 1)}, 1fr)`,
                    }}>
                      {models.map((m, mi) => {
                        const rows     = (results[m.id]?.[lang] || []).filter(r => !r.error);
                        const allRows  = results[m.id]?.[lang] || [];
                        if (!allRows.length) {
                          return (
                            <div key={m.id} style={{
                              padding: "18px 20px",
                              borderRight: mi < models.length - 1 ? "1px solid var(--surface3)" : "none",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              color: "var(--text3)", fontSize: 12,
                            }}>No data</div>
                          );
                        }

                        const passCount  = allRows.filter(r => effectivePass(r, m.id, lang)).length;
                        const acc        = allRows.length > 0 ? Math.round((passCount / allRows.length) * 100) : 0;
                        const avgLatency = rows.length > 0
                          ? Math.round(rows.reduce((s, r) => s + (r.latency || 0), 0) / rows.length)
                          : 0;
                        const totalCost  = allRows.reduce((s, r) => s + (r.cost || 0), 0);
                        const avgCost    = allRows.length > 0 ? totalCost / allRows.length : 0;

                        const accColor  = acc >= 80 ? "#10b981" : acc >= 55 ? "#f59e0b" : "#ef4444";
                        const latColor  = avgLatency < 1000 ? "#10b981" : avgLatency < 2500 ? "#f59e0b" : "#ef4444";

                        // Per-query mini breakdown
                        const queryBreakdown = queries.map(q => {
                          const row = allRows.find(r => r.queryId === q.id);
                          if (!row) return null;
                          const ep = effectivePass(row, m.id, lang);
                          return { q, row, ep };
                        }).filter(Boolean);

                        return (
                          <div key={m.id} style={{
                            padding: "18px 20px",
                            borderRight: mi < models.length - 1 ? "1px solid var(--surface3)" : "none",
                          }}>
                            {/* Model name */}
                            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 16 }}>
                              <div style={{ width: 8, height: 8, borderRadius: "50%", background: m.color }} />
                              <span style={{ fontSize: 12, fontWeight: 700, color: m.color }}>{m.name}</span>
                              <span style={{ fontSize: 10, color: "var(--text3)", marginLeft: "auto" }}>
                                {passCount}/{allRows.length} pass
                              </span>
                            </div>

                            {/* 3 metric tiles */}
                            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

                              {/* Accuracy */}
                              <div style={{
                                background: `${accColor}10`,
                                border: `1px solid ${accColor}30`,
                                borderRadius: 8, padding: "10px 14px",
                              }}>
                                <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "1px", color: accColor, fontFamily: "var(--mono)", marginBottom: 4 }}>🎯 Accuracy</div>
                                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                                  <span style={{ fontSize: 28, fontWeight: 800, color: accColor, lineHeight: 1 }}>{acc}</span>
                                  <span style={{ fontSize: 14, color: accColor, fontWeight: 600 }}>%</span>
                                </div>
                                <div style={{ marginTop: 6 }}>
                                  <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                                    <div style={{ height: "100%", width: `${acc}%`, background: accColor, borderRadius: 2, transition: "width 0.5s ease" }} />
                                  </div>
                                </div>
                              </div>

                              {/* Latency */}
                              <div style={{
                                background: `${latColor}10`,
                                border: `1px solid ${latColor}30`,
                                borderRadius: 8, padding: "10px 14px",
                              }}>
                                <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "1px", color: latColor, fontFamily: "var(--mono)", marginBottom: 4 }}>⚡ Avg Latency</div>
                                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                                  <span style={{ fontSize: 24, fontWeight: 800, color: latColor, lineHeight: 1 }}>
                                    {avgLatency >= 1000 ? (avgLatency / 1000).toFixed(1) : avgLatency}
                                  </span>
                                  <span style={{ fontSize: 13, color: latColor, fontWeight: 600 }}>
                                    {avgLatency >= 1000 ? "s" : "ms"}
                                  </span>
                                </div>
                                <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 3 }}>
                                  {avgLatency < 1000 ? "Fast" : avgLatency < 2500 ? "Moderate" : "Slow"} response
                                </div>
                              </div>

                              {/* Cost per prompt */}
                              <div style={{
                                background: "rgba(167,139,250,0.08)",
                                border: "1px solid rgba(167,139,250,0.25)",
                                borderRadius: 8, padding: "10px 14px",
                              }}>
                                <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "1px", color: "#a78bfa", fontFamily: "var(--mono)", marginBottom: 4 }}>💰 Cost / Prompt</div>
                                <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                                  <span style={{ fontSize: 12, color: "#a78bfa", fontWeight: 600 }}>$</span>
                                  <span style={{ fontSize: 22, fontWeight: 800, color: "#a78bfa", lineHeight: 1 }}>
                                    {avgCost < 0.0001 ? avgCost.toExponential(2) : avgCost.toFixed(5)}
                                  </span>
                                </div>
                                <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 3 }}>
                                  Total run: ${totalCost.toFixed(5)}
                                </div>
                              </div>
                            </div>

                            {/* Per-query mini breakdown */}
                            {queryBreakdown.length > 0 && (
                              <div style={{ marginTop: 14 }}>
                                <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "1px", color: "var(--text3)", fontFamily: "var(--mono)", marginBottom: 6 }}>Per Query</div>
                                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  {queryBreakdown.map(({ q, row, ep }) => (
                                    <div key={q.id} style={{
                                      display: "flex", alignItems: "center", gap: 7,
                                      padding: "4px 8px", borderRadius: 6,
                                      background: ep ? "rgba(16,185,129,0.05)" : "rgba(239,68,68,0.05)",
                                      border: `1px solid ${ep ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)"}`,
                                    }}>
                                      <span style={{
                                        width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                                        background: ep ? "#10b981" : "#ef4444",
                                      }} />
                                      <span style={{ fontSize: 10, color: "var(--text2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {q.query.slice(0, 36)}{q.query.length > 36 ? "…" : ""}
                                      </span>
                                      <span style={{ fontSize: 9, color: "var(--text3)", fontFamily: "var(--mono)", flexShrink: 0 }}>{row.latency}ms</span>
                                      <span style={{ fontSize: 9, color: "#a78bfa", fontFamily: "var(--mono)", flexShrink: 0 }}>${(row.cost || 0).toFixed(5)}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* Cross-model winner summary */}
              {selectedLangs.length > 0 && models.length > 1 && (
                <div style={{
                  background: "var(--surface2)", border: "1px solid var(--surface3)",
                  borderRadius: 12, padding: "16px 20px",
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 14 }}>
                    🏆 Best Model per Language
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {selectedLangs.map(lang => {
                      const langLabel = LANGUAGE_OPTIONS.find(l => l.code === lang)?.label || lang;
                      const scored = models.map(m => {
                        const rows = results[m.id]?.[lang] || [];
                        if (!rows.length) return null;
                        const pass    = rows.filter(r => effectivePass(r, m.id, lang)).length;
                        const acc     = rows.length > 0 ? pass / rows.length : 0;
                        const avgLat  = rows.length > 0 ? rows.reduce((s, r) => s + (r.latency || 0), 0) / rows.length : Infinity;
                        const avgCost = rows.length > 0 ? rows.reduce((s, r) => s + (r.cost || 0), 0) / rows.length : Infinity;
                        // Composite score: accuracy weighted most, then speed, then cost
                        const score = (acc * 0.6) - (avgLat / 100000 * 0.2) - (avgCost * 100 * 0.2);
                        return { m, acc, avgLat, avgCost, score };
                      }).filter(Boolean);
                      if (!scored.length) return null;
                      scored.sort((a, b) => b.score - a.score);
                      const winner = scored[0];
                      return (
                        <div key={lang} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "rgba(255,255,255,0.02)", borderRadius: 8 }}>
                          <span style={{ fontSize: 14 }}>
                            {({en:"🇬🇧",hi:"🇮🇳",ta:"🇮🇳",te:"🇮🇳",kn:"🇮🇳",ml:"🇮🇳",mr:"🇮🇳",gu:"🇮🇳",pa:"🇮🇳",bn:"🇮🇳",or:"🇮🇳",fr:"🇫🇷",de:"🇩🇪",es:"🇪🇸",ja:"🇯🇵",zh:"🇨🇳",ko:"🇰🇷",pt:"🇵🇹",ar:"🇸🇦",it:"🇮🇹"})[lang] || "🌐"}
                          </span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", minWidth: 90 }}>{langLabel}</span>
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: winner.m.color }} />
                          <span style={{ fontSize: 12, color: winner.m.color, fontWeight: 700 }}>{winner.m.name}</span>
                          <span style={{ fontSize: 11, color: "var(--text3)", marginLeft: 4 }}>
                            {Math.round(winner.acc * 100)}% acc · {Math.round(winner.avgLat)}ms · ${winner.avgCost.toFixed(5)}/prompt
                          </span>
                          {scored.length > 1 && (
                            <span style={{ fontSize: 10, color: "var(--text3)", marginLeft: "auto", fontStyle: "italic" }}>
                              vs {scored[1].m.name}: {Math.round(scored[1].acc * 100)}% acc · {Math.round(scored[1].avgLat)}ms
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Quality Metrics view ── */}
          {view === "quality" && (
            <div>
              {/* Metric legend */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "1.5px", fontFamily: "var(--mono)", marginBottom: 8 }}>Response Quality Dimensions</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                  {Object.entries(METRIC_META).map(([key, meta]) => (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "5px 10px" }}>
                      <span style={{ color: meta.color, fontSize: 13 }}>{meta.icon}</span>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: meta.color }}>{meta.label}</div>
                        <div style={{ fontSize: 9, color: "var(--text3)", maxWidth: 200 }}>{meta.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "1.5px", fontFamily: "var(--mono)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                  E2E Agent Evaluation Dimensions
                  <span style={{ fontSize: 8, background: "rgba(0,229,255,0.15)", color: "var(--accent)", padding: "1px 5px", borderRadius: 8, border: "1px solid rgba(0,229,255,0.3)" }}>NEW</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {Object.entries(AGENT_METRIC_META).map(([key, meta]) => (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, background: `${meta.color}08`, border: `1px solid ${meta.color}25`, borderRadius: 6, padding: "5px 10px" }}>
                      <span style={{ color: meta.color, fontSize: 13 }}>{meta.icon}</span>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: meta.color }}>{meta.label}</div>
                        <div style={{ fontSize: 9, color: "var(--text3)", maxWidth: 220 }}>{meta.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Metric comparison table — one row per metric, one column per model */}
              <div className="table-wrap" style={{ marginBottom: 20 }}>
                <table className="tc-table">
                  <thead>
                    <tr>
                      <th>Metric</th>
                      {models.map(m => <th key={m.id} style={{ color: m.color }}>{m.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Section headers via separator rows */}
                    {[
                      // Performance
                      { separator: "Performance" },
                      ["accuracy",              "Intent Accuracy",      "%",   s => s.accuracy],
                      ["avgLatency",            "Avg Latency",          " ms", s => s.avgLatency],
                      // Response Quality
                      { separator: "Response Quality" },
                      ["avgResponseAccuracy",   "Response Accuracy",    "%",   s => s.avgResponseAccuracy],
                      ["avgHallucinationScore", "Anti-Hallucination",   "%",   s => s.avgHallucinationScore],
                      ["avgFaithfulness",       "Faithfulness",         "%",   s => s.avgFaithfulness],
                      ["avgCompleteness",       "Completeness",         "%",   s => s.avgCompleteness],
                      ["avgSafetyScore",        "Safety & Compliance",  "%",   s => s.avgSafetyScore],
                      ["avgOverallQuality",     "Overall Quality ★",    "%",   s => s.avgOverallQuality],
                      // E2E Agent
                      { separator: "E2E Agent Evaluation" },
                      ["avgTaskCompletion",     "Task Completion Rate", "%",   s => s.avgTaskCompletion],
                      ["avgReasoning",          "Reasoning Quality",    "%",   s => s.avgReasoning],
                      ["avgToolSelection",      "Tool Selection Acc.",  "%",   s => s.avgToolSelection],
                      ["avgToolExecution",      "Tool Execution Succ.", "%",   s => s.avgToolExecution],
                      ["avgMemory",             "Memory Utilization",   "%",   s => s.avgMemory],
                    ].map((item, rowIdx) => {
                      if (item.separator) {
                        return (
                          <tr key={`sep-${rowIdx}`}>
                            <td colSpan={summaries.length + 1} style={{ background: "rgba(255,255,255,0.03)", padding: "6px 12px", fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "1.5px", fontFamily: "var(--mono)", fontWeight: 700 }}>
                              {item.separator}
                            </td>
                          </tr>
                        );
                      }
                      const [key, label, unit, getter] = item;
                      const agentKeys = ["avgTaskCompletion","avgReasoning","avgToolSelection","avgToolExecution","avgMemory"];
                      const isAgent   = agentKeys.includes(key);
                      const agentMeta = isAgent ? Object.values(AGENT_METRIC_META)[agentKeys.indexOf(key)] : null;
                      return (
                        <tr key={key}>
                          <td style={{ fontWeight: 600, fontSize: 12, color: agentMeta ? agentMeta.color : "var(--text)" }}>
                            {agentMeta && <span style={{ marginRight: 5 }}>{agentMeta.icon}</span>}
                            {label}
                          </td>
                          {summaries.map(s => {
                            const val = getter(s);
                            if (val === null || val === undefined) return <td key={s.model.id} style={{ color: "var(--text3)", fontSize: 11 }}>—</td>;
                            const col = key === "avgLatency" ? "#f59e0b" : isAgent ? agentMetricColor(val) : metricColor(val);
                            return (
                              <td key={s.model.id}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <div style={{ flex: 1, background: "rgba(255,255,255,0.06)", borderRadius: 3, height: 6, minWidth: 60, overflow: "hidden" }}>
                                    <div style={{ width: `${key === "avgLatency" ? Math.min(100, val / 3000 * 100) : val}%`, background: col, height: "100%", borderRadius: 3, transition: "width 0.4s" }} />
                                  </div>
                                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: col, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{val}{unit}</span>
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Safety flags per model */}
              {summaries.some(s => s.unsafeCount > 0 || s.highHalluCount > 0) && (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 10 }}>⛨ Risk Alerts</div>
                  {summaries.map(s => {
                    const allRows = selectedLangs.flatMap(lang => results[s.model.id]?.[lang] || []);
                    const unsafe  = allRows.filter(r => !r.safetyPassed);
                    const highH   = allRows.filter(r => r.hallucinationLevel === "high" || r.hallucinationLevel === "medium");
                    if (!unsafe.length && !highH.length) return null;
                    return (
                      <div key={s.model.id} style={{ background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "12px 16px", marginBottom: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: s.model.color, marginBottom: 8 }}>{s.model.name}</div>
                        {unsafe.map((r, i) => (
                          <div key={i} style={{ marginBottom: 6 }}>
                            <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", marginBottom: 3 }}>"{(r.query || "").slice(0, 80)}"</div>
                            {(r.safetyFlags || []).map((f, j) => (
                              <div key={j} style={{ fontSize: 11, display: "flex", gap: 8, alignItems: "center" }}>
                                <span style={{ color: f.severity === "critical" ? "#ef4444" : f.severity === "high" ? "#f97316" : "#f59e0b", fontWeight: 700, fontFamily: "var(--mono)", minWidth: 60 }}>{f.severity.toUpperCase()}</span>
                                <span style={{ color: "var(--text2)" }}>{f.category} — {f.tip}</span>
                                <span style={{ color: "var(--text3)", fontFamily: "var(--mono)", fontSize: 10 }}>"{f.match}"</span>
                              </div>
                            ))}
                          </div>
                        ))}
                        {highH.map((r, i) => (
                          <div key={`h${i}`} style={{ marginBottom: 6 }}>
                            <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", marginBottom: 3 }}>"{(r.query || "").slice(0, 80)}"</div>
                            <div style={{ fontSize: 11, display: "flex", gap: 8, alignItems: "center" }}>
                              <span style={{ color: "#f97316", fontWeight: 700, fontFamily: "var(--mono)", minWidth: 60 }}>HALLUC</span>
                              <span style={{ color: "var(--text2)" }}>Level: {r.hallucinationLevel} — flagged claims: {(r.hallucinationFlags || []).slice(0, 4).join(", ")}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Per-query advanced metrics table */}
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", margin: "20px 0 10px" }}>Per-Query Full Metrics (Quality + Agent)</div>
              <div className="table-wrap">
                <table className="tc-table">
                  <thead>
                    <tr>
                      <th>Query</th>
                      <th>Lang</th>
                      <th>Model</th>
                      {/* Quality */}
                      <th style={{ color: "#10b981" }}>Resp.Acc</th>
                      <th style={{ color: "#f59e0b" }}>Halluc.</th>
                      <th style={{ color: "#00e5ff" }}>Faith.</th>
                      <th style={{ color: "#a78bfa" }}>Compl.</th>
                      <th style={{ color: "#ef4444" }}>Safety</th>
                      <th>Overall Q</th>
                      {/* Agent */}
                      <th style={{ color: "#f97316", borderLeft: "2px solid rgba(249,115,22,0.3)" }}>Task ★</th>
                      <th style={{ color: "#00e5ff" }}>🧠 Reason.</th>
                      <th style={{ color: "#a78bfa" }}>⚙ Tool Sel.</th>
                      <th style={{ color: "#10b981" }}>✓ Tool Exec.</th>
                      <th style={{ color: "#f59e0b" }}>◉ Memory</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queries.flatMap(q =>
                      selectedLangs.flatMap(lang =>
                        models.map(m => {
                          const r = results[m.id]?.[lang]?.find(x => x.queryId === q.id);
                          if (!r) return null;
                          const hB = hallucinationBadge(r.hallucinationLevel);
                          const sB = safetyBadge(r.safetyPassed, r.safetyFlags || []);
                          const qCell = (val) => val === null || val === undefined
                            ? <td style={{ color: "var(--text3)", fontSize: 10 }}>—</td>
                            : <td><span style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: 11, color: metricColor(val) }}>{val}%</span></td>;
                          const aCell = (val) => val === null || val === undefined
                            ? <td style={{ color: "var(--text3)", fontSize: 10 }}>—</td>
                            : <td><span style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: 11, color: agentMetricColor(val) }}>{val}%</span></td>;
                          return (
                            <tr key={`${q.id}-${lang}-${m.id}`}>
                              <td style={{ maxWidth: 160, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={q.query}>{q.query}</td>
                              <td style={{ fontSize: 10 }}>{LANGUAGE_OPTIONS.find(l => l.code === lang)?.label || lang}</td>
                              <td style={{ color: m.color, fontWeight: 600, fontSize: 11 }}>{m.name}</td>
                              {/* Quality */}
                              {qCell(r.responseAccuracy)}
                              <td><span style={{ fontFamily: "var(--mono)", fontWeight: 700, color: hB.color, fontSize: 11 }}>{hB.label}</span></td>
                              {qCell(r.faithfulnessScore)}
                              {qCell(r.completenessScore)}
                              <td><span style={{ fontFamily: "var(--mono)", fontWeight: 700, color: sB.color, fontSize: 11 }}>{sB.label}</span></td>
                              {qCell(r.overallQuality)}
                              {/* Agent */}
                              <td style={{ borderLeft: "2px solid rgba(249,115,22,0.2)" }}>
                                <span style={{ fontFamily: "var(--mono)", fontWeight: 800, fontSize: 12, color: agentMetricColor(r.taskCompletionScore) }}>{r.taskCompletionScore ?? "—"}{r.taskCompletionScore !== null && r.taskCompletionScore !== undefined ? "%" : ""}</span>
                              </td>
                              {aCell(r.reasoningScore)}
                              {aCell(r.toolSelectionScore)}
                              {aCell(r.toolExecutionScore)}
                              {r.memoryScore !== null && r.memoryScore !== undefined
                                ? aCell(r.memoryScore)
                                : <td style={{ color: "var(--text3)", fontSize: 9, fontStyle: "italic" }}>N/A</td>}
                            </tr>
                          );
                        }).filter(Boolean)
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Per-view export bar ── */}
          {(() => {
            const VIEW_EXPORTS = {
              summary: {
                label:   "↓ Summary CSV",
                title:   "Model comparison — accuracy, latency, cost per model",
                fn:      () => exportSummaryCSV(results, models, selectedLangs, queries),
              },
              detail: {
                label:   "↓ Detail CSV",
                title:   "Full query × model × language matrix with pass/fail, response, latency, cost",
                fn:      () => exportPrismCSV(results, models, queries, selectedLangs),
              },
              lang: {
                label:   "↓ Language Matrix CSV",
                title:   "Language × model — accuracy, avg latency, cost per prompt",
                fn:      () => exportLangCSV(results, models, queries, selectedLangs),
              },
              quality: {
                label:   "↓ Quality Metrics CSV",
                title:   "Model × all quality & agent metric scores",
                fn:      () => exportQualityCSV(results, models, queries, selectedLangs),
              },
              raw: {
                label:   "↓ Raw Responses CSV",
                title:   "Query, language, model, full response text, judge verdict, override, latency, cost",
                fn:      () => exportRawCSV(results, models, queries, selectedLangs, judgments, overrides, judgeKey),
              },
            };
            const exp = VIEW_EXPORTS[view] || VIEW_EXPORTS.detail;
            return (
              <div style={{
                marginTop: 20, padding: "12px 16px",
                background: "rgba(255,255,255,0.02)",
                border: "1px solid var(--surface3)",
                borderRadius: 10,
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 12, flexWrap: "wrap",
              }}>
                <div style={{ fontSize: 11, color: "var(--text3)" }}>
                  <span style={{ fontWeight: 600, color: "var(--text2)" }}>Download:</span>
                  {" "}report tailored for the <strong style={{ color: "var(--accent)" }}>
                    {{"summary":"Summary","detail":"Per-Query Detail","lang":"Language Breakdown","quality":"Quality Metrics","raw":"Raw Responses"}[view] || view}
                  </strong> view
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {/* View-specific CSV */}
                  <button
                    className="btn btn-outline"
                    style={{ fontSize: 11, padding: "5px 12px", display: "flex", alignItems: "center", gap: 5 }}
                    onClick={exp.fn}
                    title={exp.title}
                  >
                    <span style={{ fontSize: 13 }}>📄</span> {exp.label}
                  </button>
                  {/* Full HTML report — always available */}
                  <button
                    className="btn btn-success"
                    style={{ fontSize: 11, padding: "5px 12px", display: "flex", alignItems: "center", gap: 5 }}
                    onClick={() => downloadPrismAllureReport({ results, models, queries, selectedLangs, projectName: "AURA" })}
                    title="Full Allure-style interactive HTML report covering all tabs"
                  >
                    <span style={{ fontSize: 13 }}>📊</span> Full HTML Report
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Custom model editor removed — models are now loaded from .env.model* files */}

      {/* ── Raw Responses tab ── LLM judge + manual overrides + disagreement log ── */}
      {results && view === "raw" && (() => {
        // Collect all disagreements: heuristic FAIL but LLM says correct (or vice-versa)
        const disagreements = [];
        for (const q of queries) {
          for (const lang of selectedLangs) {
            for (const m of models) {
              const row = results[m.id]?.[lang]?.find(r => r.queryId === q.id);
              if (!row) continue;
              const k  = judgeKey(m.id, lang, q.id);
              const jv = judgments[k]?.verdict;
              if (!jv || jv === "unknown") continue;
              const heurPass  = row.pass;
              const judgePass = jv === "correct";
              if (heurPass !== judgePass) {
                disagreements.push({ q, lang, m, row, jv, heurPass, judgePass, k });
              }
            }
          }
        }

        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Top controls */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, color: "var(--text3)", flex: 1 }}>
                💡 See exact model replies, run the <strong>LLM Judge</strong> for a semantic second opinion, or manually override any result. Overrides propagate to the Summary tab.
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--text3)" }}>Judge model:</span>
                <select
                  value={judgeModel}
                  onChange={e => setJudgeModel(e.target.value)}
                  style={{ fontSize: 11, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--surface3)", borderRadius: 5, padding: "3px 8px" }}
                >
                  <option value="gpt-4o-mini">gpt-4o-mini</option>
                  <option value="gpt-4o">gpt-4o</option>
                  <option value="gpt-4-turbo">gpt-4-turbo</option>
                </select>
                <button
                  className="btn btn-primary"
                  style={{ fontSize: 11, padding: "4px 12px" }}
                  disabled={judgingAll}
                  onClick={judgeAll}
                  title="Ask the LLM to grade every result in this run"
                >
                  {judgingAll ? "⏳ Judging…" : "🧠 Judge All"}
                </button>
              </div>
            </div>

            {/* Disagreement alert banner */}
            {disagreements.length > 0 && (
              <div style={{
                background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.3)",
                borderRadius: 10, padding: "12px 16px",
              }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: "#fbbf24", marginBottom: 8 }}>
                  ⚠ {disagreements.length} Heuristic ↔ LLM Judge Disagreement{disagreements.length !== 1 ? "s" : ""}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {disagreements.map(({ q, lang, m, row, jv, heurPass, k }, di) => {
                    const ov = overrides[k];
                    return (
                      <div key={di} style={{
                        display: "flex", alignItems: "flex-start", gap: 10,
                        background: "rgba(251,191,36,0.04)", borderRadius: 7, padding: "8px 12px",
                      }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, color: "var(--text)", marginBottom: 3 }}>
                            <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", marginRight: 6 }}>{q.id}</span>
                            <strong>{m.name}</strong>
                            <span style={{ color: "var(--text3)", margin: "0 6px" }}>·</span>
                            <span style={{ textTransform: "uppercase", fontSize: 10, color: "var(--text3)" }}>{lang}</span>
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text3)" }}>
                            Heuristic: <strong style={{ color: heurPass ? "#10b981" : "#ef4444" }}>{heurPass ? "PASS" : "FAIL"}</strong>
                            <span style={{ margin: "0 6px" }}>·</span>
                            LLM Judge: <strong style={{ color: jv === "correct" ? "#10b981" : "#f59e0b" }}>{jv.toUpperCase()}</strong>
                            {judgments[k]?.explanation && (
                              <span style={{ fontStyle: "italic", color: "var(--text3)", marginLeft: 8 }}>
                                — {judgments[k].explanation}
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                          {ov ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{
                                fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                                background: ov === "correct" ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)",
                                color: ov === "correct" ? "#10b981" : "#ef4444",
                              }}>
                                Overridden: {ov === "correct" ? "CORRECT" : "WRONG"}
                              </span>
                              <button style={{ fontSize: 10, background: "none", border: "1px solid rgba(255,255,255,0.1)", color: "var(--text3)", borderRadius: 4, cursor: "pointer", padding: "2px 6px" }}
                                onClick={() => setOverrides(prev => { const n = {...prev}; delete n[k]; return n; })}>
                                undo
                              </button>
                            </div>
                          ) : (
                            <>
                              <button className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px" }}
                                onClick={() => setOverrides(prev => ({ ...prev, [k]: "correct" }))}>
                                ✓ Mark Correct
                              </button>
                              <button className="btn btn-danger" style={{ fontSize: 10, padding: "2px 8px" }}
                                onClick={() => setOverrides(prev => ({ ...prev, [k]: "wrong" }))}>
                                ✗ Mark Wrong
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Per-query cards */}
            {queries.map(q => (
              <div key={q.id} style={{ background: "var(--surface2)", borderRadius: 10, overflow: "hidden", border: "1px solid var(--surface3)" }}>
                <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--surface3)", display: "flex", gap: 12, alignItems: "center" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)" }}>{q.id}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>"{q.query}"</span>
                  <span className="intent-pill" style={{ fontSize: 10, marginLeft: "auto" }}>{q.expectedIntent}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(models.length, 1)}, 1fr)` }}>
                  {models.map((m, mi) => {
                    const langRows = selectedLangs.flatMap(lang => {
                      const row = results[m.id]?.[lang]?.find(r => r.queryId === q.id);
                      return row ? [{ lang, row }] : [];
                    });
                    return (
                      <div key={m.id} style={{
                        borderRight: mi < models.length - 1 ? "1px solid var(--surface3)" : "none",
                        padding: "12px 14px",
                      }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: m.color }} />
                          <strong style={{ fontSize: 12, color: m.color }}>{m.name}</strong>
                        </div>
                        {langRows.map(({ lang, row }) => {
                          const k  = judgeKey(m.id, lang, q.id);
                          const jd = judgments[k];
                          const ov = overrides[k];
                          const effPass = effectivePass(row, m.id, lang);
                          const heurDisagrees = jd?.verdict && jd.verdict !== "unknown" &&
                            (row.pass !== (jd.verdict === "correct"));

                          return (
                            <div key={lang} style={{
                              marginBottom: 14,
                              borderLeft: heurDisagrees ? "3px solid #fbbf24" : "3px solid transparent",
                              paddingLeft: 8,
                            }}>
                              {/* Status row */}
                              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 5, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>{lang}</span>

                                {/* Effective verdict badge */}
                                <span className={`badge ${effPass ? "badge-pass" : "badge-fail"}`} style={{ fontSize: 9 }}>
                                  {ov ? "OVERRIDE:" : ""}{effPass ? "PASS" : "FAIL"}
                                </span>

                                {/* Heuristic source indicator */}
                                {!ov && !jd && (
                                  <span style={{ fontSize: 9, color: "var(--text3)", padding: "1px 5px", borderRadius: 4, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}>heuristic</span>
                                )}

                                {/* LLM judge verdict */}
                                {jd && !jd.judging && jd.verdict !== "unknown" && (
                                  <span style={{
                                    fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4,
                                    background: jd.verdict === "correct" ? "rgba(16,185,129,0.12)" : jd.verdict === "partial" ? "rgba(251,191,36,0.12)" : "rgba(239,68,68,0.12)",
                                    color:      jd.verdict === "correct" ? "#10b981" : jd.verdict === "partial" ? "#fbbf24" : "#ef4444",
                                    border:     `1px solid ${jd.verdict === "correct" ? "rgba(16,185,129,0.25)" : jd.verdict === "partial" ? "rgba(251,191,36,0.25)" : "rgba(239,68,68,0.25)"}`,
                                  }} title={jd.explanation}>
                                    🧠 Judge: {jd.verdict} ({Math.round((jd.confidence || 0) * 100)}%)
                                  </span>
                                )}
                                {jd?.judging && (
                                  <span style={{ fontSize: 9, color: "var(--accent)", fontStyle: "italic" }}>⏳ judging…</span>
                                )}

                                {heurDisagrees && !ov && (
                                  <span style={{ fontSize: 9, color: "#fbbf24", fontWeight: 700 }}>⚠ disagrees</span>
                                )}

                                <span style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", marginLeft: "auto" }}>{row.latency}ms</span>
                              </div>

                              {/* LLM judge explanation */}
                              {jd?.explanation && !jd.judging && (
                                <div style={{ fontSize: 10, color: "var(--text3)", fontStyle: "italic", marginBottom: 5, lineHeight: 1.4 }}>
                                  {jd.explanation}
                                </div>
                              )}

                              {/* Error or response */}
                              {row.error ? (
                                <div style={{ fontSize: 11, color: "#ef4444", background: "rgba(239,68,68,0.08)", borderRadius: 6, padding: "6px 10px", fontFamily: "var(--mono)" }}>
                                  ⚠ {row.error}
                                </div>
                              ) : (
                                <>
                                  <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 4 }}>
                                    Heuristic intent: <span className="intent-pill" style={{ fontSize: 9 }}>{row.actualIntent}</span>
                                  </div>
                                  <div style={{
                                    fontSize: 11, color: "var(--text)", lineHeight: 1.6,
                                    background: "var(--surface)", borderRadius: 6,
                                    padding: "8px 10px", maxHeight: 120, overflowY: "auto",
                                    fontStyle: "italic", whiteSpace: "pre-wrap",
                                  }}>
                                    "{row.message || "(no response)"}"
                                  </div>
                                </>
                              )}

                              {/* Action buttons */}
                              <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
                                {!jd?.judging && !row.error && (
                                  <button
                                    style={{ fontSize: 9, padding: "2px 7px", background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.25)", color: "#a78bfa", borderRadius: 4, cursor: "pointer" }}
                                    onClick={() => judgeOne(row, m.id, lang, q.query, q.expectedIntent)}
                                  >
                                    🧠 {jd ? "Re-judge" : "LLM Judge"}
                                  </button>
                                )}

                                {ov ? (
                                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                    <span style={{
                                      fontSize: 9, padding: "2px 7px", borderRadius: 4, fontWeight: 700,
                                      background: ov === "correct" ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)",
                                      color: ov === "correct" ? "#10b981" : "#ef4444",
                                    }}>
                                      Overridden: {ov === "correct" ? "✓ Correct" : "✗ Wrong"}
                                    </span>
                                    <button
                                      style={{ fontSize: 9, padding: "2px 6px", background: "none", border: "1px solid rgba(255,255,255,0.1)", color: "var(--text3)", borderRadius: 4, cursor: "pointer" }}
                                      onClick={() => setOverrides(prev => { const n = {...prev}; delete n[k]; return n; })}
                                    >undo</button>
                                  </div>
                                ) : (
                                  <>
                                    <button
                                      style={{ fontSize: 9, padding: "2px 7px", background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)", color: "#10b981", borderRadius: 4, cursor: "pointer" }}
                                      onClick={() => setOverrides(prev => ({ ...prev, [k]: "correct" }))}
                                      title="Manually mark this as correct — overrides both heuristic and LLM judge"
                                    >
                                      ✓ Mark Correct
                                    </button>
                                    <button
                                      style={{ fontSize: 9, padding: "2px 7px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#ef4444", borderRadius: 4, cursor: "pointer" }}
                                      onClick={() => setOverrides(prev => ({ ...prev, [k]: "wrong" }))}
                                      title="Manually mark this as wrong — overrides both heuristic and LLM judge"
                                    >
                                      ✗ Mark Wrong
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

// ── Shared CSV download helper ──────────────────────────────────────────────
function _downloadCSV(rows, filename) {
  const csv  = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a    = document.createElement("a");
  a.href     = URL.createObjectURL(blob);
  a.download = `${filename}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ── Per-Query Detail CSV (existing, untouched) ──────────────────────────────
function exportPrismCSV(results, models, queries, langs) {
  const header = [
    "Query", "Expected Intent", "Language",
    ...models.flatMap(m => [
      `${m.name} Pass`, `${m.name} Detected Intent`,
      `${m.name} Latency(ms)`, `${m.name} Cost($)`,
    ]),
  ];
  const rows = [header];
  for (const q of queries) {
    for (const lang of langs) {
      const row = [q.query, q.expectedIntent, lang];
      for (const m of models) {
        const r = results[m.id]?.[lang]?.find(x => x.queryId === q.id);
        row.push(r ? (r.pass ? "PASS" : "FAIL") : "—");
        row.push(r?.actualIntent || "—");
        row.push(r?.latency ?? "—");
        row.push(r ? r.cost.toFixed(6) : "—");
      }
      rows.push(row);
    }
  }
  _downloadCSV(rows, "PRISM_PerQuery_Detail");
}

// ── Summary CSV — one row per model ────────────────────────────────────────
function exportSummaryCSV(results, models, langs, queries) {
  const header = [
    "Model", "Provider", "Total Tests", "Passed", "Failed",
    "Accuracy (%)", "Avg Latency (ms)", "Total Cost ($)", "Avg Cost / Prompt ($)",
  ];
  const rows = [header];
  for (const m of models) {
    let total = 0, pass = 0, totalLat = 0, totalCost = 0;
    for (const lang of langs) {
      const langRows = results[m.id]?.[lang] || [];
      total     += langRows.length;
      pass      += langRows.filter(r => r.pass).length;
      totalLat  += langRows.reduce((s, r) => s + (r.latency || 0), 0);
      totalCost += langRows.reduce((s, r) => s + (r.cost    || 0), 0);
    }
    rows.push([
      m.name,
      m.provider || "—",
      total,
      pass,
      total - pass,
      total > 0 ? Math.round((pass / total) * 100) : 0,
      total > 0 ? Math.round(totalLat / total) : 0,
      totalCost.toFixed(6),
      total > 0 ? (totalCost / total).toFixed(6) : 0,
    ]);
  }
  _downloadCSV(rows, "PRISM_Summary");
}

// ── Language Breakdown CSV — rows: language × model ─────────────────────────
function exportLangCSV(results, models, queries, langs) {
  const header = [
    "Language", "Model",
    "Total Queries", "Passed", "Failed",
    "Accuracy (%)", "Avg Latency (ms)",
    "Total Cost ($)", "Avg Cost / Prompt ($)",
    ...queries.map(q => `Q: ${q.query.slice(0, 40)} — Pass`),
    ...queries.map(q => `Q: ${q.query.slice(0, 40)} — Latency(ms)`),
    ...queries.map(q => `Q: ${q.query.slice(0, 40)} — Cost($)`),
  ];
  const rows = [header];
  for (const lang of langs) {
    for (const m of models) {
      const langRows = results[m.id]?.[lang] || [];
      if (!langRows.length) continue;
      const pass      = langRows.filter(r => r.pass).length;
      const avgLat    = Math.round(langRows.reduce((s, r) => s + (r.latency || 0), 0) / langRows.length);
      const totalCost = langRows.reduce((s, r) => s + (r.cost || 0), 0);
      const row = [
        lang, m.name,
        langRows.length, pass, langRows.length - pass,
        Math.round((pass / langRows.length) * 100),
        avgLat,
        totalCost.toFixed(6),
        (totalCost / langRows.length).toFixed(6),
      ];
      for (const q of queries) {
        const r = langRows.find(x => x.queryId === q.id);
        row.push(r ? (r.pass ? "PASS" : "FAIL") : "—");
      }
      for (const q of queries) {
        const r = langRows.find(x => x.queryId === q.id);
        row.push(r?.latency ?? "—");
      }
      for (const q of queries) {
        const r = langRows.find(x => x.queryId === q.id);
        row.push(r ? (r.cost || 0).toFixed(6) : "—");
      }
      rows.push(row);
    }
  }
  _downloadCSV(rows, "PRISM_Language_Breakdown");
}

// ── Quality Metrics CSV — rows: model, columns: every metric ────────────────
function exportQualityCSV(results, models, queries, langs) {
  const header = [
    "Model",
    "Accuracy (%)", "Avg Latency (ms)", "Avg Cost ($)",
    "Response Accuracy", "Hallucination Score", "Faithfulness",
    "Completeness", "Safety Score",
    "Reasoning Quality", "Tool Selection", "Tool Execution",
    "Memory Utilization", "Task Completion Rate",
  ];
  function avg(rows, key) {
    const vals = rows.map(r => r[key]).filter(v => v != null && !isNaN(v));
    return vals.length > 0 ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : "—";
  }
  const rows = [header];
  for (const m of models) {
    const allRows = langs.flatMap(lang => results[m.id]?.[lang] || []);
    if (!allRows.length) continue;
    const pass = allRows.filter(r => r.pass).length;
    rows.push([
      m.name,
      Math.round((pass / allRows.length) * 100),
      Math.round(allRows.reduce((s, r) => s + (r.latency || 0), 0) / allRows.length),
      (allRows.reduce((s, r) => s + (r.cost || 0), 0) / allRows.length).toFixed(6),
      avg(allRows, "responseAccuracy"),
      avg(allRows, "hallucinationScore"),
      avg(allRows, "faithfulnessScore"),
      avg(allRows, "completenessScore"),
      avg(allRows, "safetyScore"),
      avg(allRows, "reasoningScore"),
      avg(allRows, "toolSelectionScore"),
      avg(allRows, "toolExecutionScore"),
      avg(allRows, "memoryScore"),
      avg(allRows, "taskCompletionScore"),
    ]);
  }
  _downloadCSV(rows, "PRISM_Quality_Metrics");
}

// ── Raw Responses CSV — full text + judge + override ────────────────────────
function exportRawCSV(results, models, queries, langs, judgments, overrides, judgeKey) {
  const header = [
    "Query ID", "Query Text", "Expected Intent", "Language", "Model",
    "Heuristic Pass", "Effective Pass",
    "Detected Intent", "Latency (ms)", "Cost ($)", "Tokens Used",
    "LLM Judge Verdict", "Judge Confidence", "Judge Explanation",
    "Manual Override",
    "Full Response",
  ];
  const rows = [header];
  for (const q of queries) {
    for (const lang of langs) {
      for (const m of models) {
        const r = results[m.id]?.[lang]?.find(x => x.queryId === q.id);
        if (!r) continue;
        const k  = judgeKey(m.id, lang, q.id);
        const jd = judgments?.[k];
        const ov = overrides?.[k];
        let effPass = r.pass;
        if (ov === "correct") effPass = true;
        else if (ov === "wrong") effPass = false;
        else if (jd?.verdict === "correct")   effPass = true;
        else if (jd?.verdict === "incorrect") effPass = false;
        rows.push([
          q.id, q.query, q.expectedIntent, lang, m.name,
          r.pass ? "PASS" : "FAIL",
          effPass ? "PASS" : "FAIL",
          r.actualIntent || "—",
          r.latency ?? "—",
          (r.cost || 0).toFixed(6),
          r.totalTokens ?? "—",
          jd?.verdict     || "not judged",
          jd?.confidence != null ? (jd.confidence * 100).toFixed(0) + "%" : "—",
          jd?.explanation || "—",
          ov || "none",
          r.message || "",
        ]);
      }
    }
  }
  _downloadCSV(rows, "PRISM_Raw_Responses");
}
