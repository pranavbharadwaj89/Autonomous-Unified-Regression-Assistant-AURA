/** HTTP client for CARA backend (health + process-text) and QA Runner DB API. */

import { DEFAULT_BACKEND_URL, VEHICLE_MODULE_RE } from "../config/backend.js";

const QA_RUNNER_BASE = "http://localhost:3001";

function trimSlash(url) {
  return url.replace(/\/+$/, "");
}

export function getBackendBaseUrl(config) {
  return trimSlash(config?.backendUrl || DEFAULT_BACKEND_URL);
}

export function shouldAttachVehicleHeaders(config, testCase) {
  if (!config?.enableRegressionVehicle) return false;
  const mod = String(testCase?.module || "");
  return VEHICLE_MODULE_RE.test(mod);
}

async function parseErrorResponse(resp) {
  try {
    const body = await resp.json();
    const detail = body?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map((d) => d.msg || JSON.stringify(d)).join("; ");
    }
    if (detail) return JSON.stringify(detail);
    return body?.message || resp.statusText;
  } catch {
    return resp.statusText;
  }
}

export async function checkBackendHealth(backendUrl) {
  const base = trimSlash(backendUrl);
  const resp = await fetch(`${base}/health`);
  if (!resp.ok) {
    throw new Error(`Health check failed: HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function processText({ config, brand, text, deviceId, testCase = null }) {
  const base = getBackendBaseUrl(config);
  const body = {
    text,
    deviceId: deviceId || config.deviceId,
    language: config.language,
    model_name: config.modelName,
    user_timezone: config.timezone,
    latitude: parseFloat(config.latitude) || null,
    longitude: parseFloat(config.longitude) || null,
    include_tts: false,
  };

  const headers = {
    "Content-Type": "application/json",
    "X-Brand": brand || "citroen",
  };

  if (shouldAttachVehicleHeaders(config, testCase)) {
    headers.Authorization = `Bearer ${config.regressionVehicleToken || "cara-regression-mock"}`;
    headers["X-Vehicle-Backend"] = config.vehicleBackend || "cvip";
    headers["X-VIN"] = config.vehicleVin || "REGRESSION_VIN001";
    headers["X-Cara-Regression"] = "1";
  }

  const resp = await fetch(`${base}/api/v1/process-text`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const message = await parseErrorResponse(resp);
    throw new Error(`HTTP ${resp.status}: ${message}`);
  }

  return resp.json();
}

/** Split embedded multi-turn prompts like "Turn 1: A | Turn 2: B". */
export function parseTurnInputs(input) {
  const text = String(input || "").trim();
  if (!text) return [];
  if (!/^turn\s*\d+\s*:/i.test(text) && !text.includes("| Turn")) {
    return [text];
  }
  return text
    .split(/\s*\|\s*/)
    .map((part) => part.replace(/^turn\s*\d+\s*:\s*/i, "").trim())
    .filter(Boolean);
}

/** Run one or more turns sequentially on the same device id; returns last response. */
export async function processTextTurns({ config, brand, deviceId, testCase, delayMs = 400 }) {
  const turns = parseTurnInputs(testCase?.input);
  if (!turns.length) {
    return processText({ config, brand, text: "", deviceId, testCase });
  }
  let last;
  for (const turnText of turns) {
    last = await processText({
      config,
      brand,
      text: turnText,
      deviceId,
      testCase,
    });
    if (delayMs > 0 && turns.length > 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return last;
}

// ── QA Runner DB API ──────────────────────────────────────────────────────────

/**
 * Persist a completed regression run + results to PostgreSQL via the QA Runner.
 * Returns { run_id } on success or throws on network/DB error.
 */
export async function saveTestRunToDB({ reportData, testCases, projectName = "CARA", brand, backendUrl }) {
  const results = reportData?.results || {};
  const total   = testCases.length;
  const passed  = testCases.filter(tc => results[tc.id]?.pass).length;
  const failed  = total - passed;

  const flatResults = testCases.map(tc => {
    const r  = results[tc.id] || {};
    const tk = r.toolCheck   || {};
    const ic = r.intentChain || {};
    return {
      tc_id:           tc.id,
      module:          tc.module,
      flow:            tc.flow,
      input_text:      tc.input,
      expected_intent: tc.expectedIntent,
      actual_intent:   r.actualIntent  || null,
      pass:            !!r.pass,
      confidence:      r.confidence    ?? null,
      match_source:    r.matchSource   || null,
      expected_tool:   tk.expectedTool || ic.tool    || null,
      actual_tool:     tk.actualTool   || null,
      tool_routing_ok: tk.isCorrect !== false,
      routing_warning: tk.warning      || null,
      intent_chain:    ic.chain        || null,
      response_message: r.message      || null,
      error_message:   r.error         || null,
      latency_ms:      r.latencyMs     ?? null,
    };
  });

  const resp = await fetch(`${QA_RUNNER_BASE}/db/test-runs`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      run_label:    `${projectName} — ${new Date().toLocaleString("en-IN")}`,
      project_name: projectName,
      backend_url:  backendUrl || null,
      brand:        brand      || null,
      total, passed, failed,
      started_at:  reportData?.runAt || null,
      finished_at: new Date().toISOString(),
      results:     flatResults,
    }),
  });
  if (!resp.ok) throw new Error(`DB save failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

/**
 * Persist a completed PRISM run to PostgreSQL via the QA Runner.
 */
export async function savePrismRunToDB({ results, models, queries, selectedLangs, projectName = "CARA", backendUrl }) {
  const flatResults = [];
  for (const m of models) {
    for (const lang of selectedLangs) {
      const rows = results[m.id]?.[lang] || [];
      for (const r of rows) {
        flatResults.push({
          model_id:        m.id,
          model_name:      m.name,
          model_provider:  m.provider,
          language_code:   lang,
          query_id:        r.queryId,
          query_text:      r.query,
          expected_intent: r.expectedIntent || null,
          actual_intent:   r.actualIntent   || null,
          pass:            !!r.pass,
          confidence:      r.confidence     ?? null,
          match_source:    r.matchSource    || null,
          latency_ms:      r.latency        ?? null,
          input_tokens:    r.inputTokens    ?? null,
          output_tokens:   r.outputTokens   ?? null,
          cost_usd:        r.cost           ?? null,
          response_message: r.message       || null,
          error_message:   r.error          || null,
        });
      }
    }
  }

  const resp = await fetch(`${QA_RUNNER_BASE}/db/prism-runs`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      run_label:    `PRISM — ${new Date().toLocaleString("en-IN")}`,
      project_name: projectName,
      backend_url:  backendUrl || null,
      models,
      languages:    selectedLangs,
      query_count:  queries.length,
      started_at:   new Date().toISOString(),
      results:      flatResults,
    }),
  });
  if (!resp.ok) throw new Error(`DB save failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

/** Fetch all regression runs stored in the DB. */
export async function fetchDBTestRuns(limit = 50) {
  const resp = await fetch(`${QA_RUNNER_BASE}/db/test-runs?limit=${limit}`);
  if (!resp.ok) throw new Error(`Failed to fetch runs: ${resp.status}`);
  return resp.json();
}

/** Fetch all PRISM runs stored in the DB. */
export async function fetchDBPrismRuns(limit = 50) {
  const resp = await fetch(`${QA_RUNNER_BASE}/db/prism-runs?limit=${limit}`);
  if (!resp.ok) throw new Error(`Failed to fetch PRISM runs: ${resp.status}`);
  return resp.json();
}

/** Check DB connectivity. */
export async function checkDBHealth() {
  try {
    const resp = await fetch(`${QA_RUNNER_BASE}/db/health`);
    return resp.ok ? resp.json() : { status: "error" };
  } catch {
    return { status: "unreachable" };
  }
}
