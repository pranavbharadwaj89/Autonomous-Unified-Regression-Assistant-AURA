/** HTTP client for the CARA QA runner (voice E2E suites). */

import { DEFAULT_QA_RUNNER_URL } from "../config/qaRunner.js";

function trimSlash(url) {
  return url.replace(/\/+$/, "");
}

export function getQaRunnerBaseUrl(override) {
  return trimSlash(override || DEFAULT_QA_RUNNER_URL);
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

async function qaFetch(path, { baseUrl, ...init } = {}) {
  const base = getQaRunnerBaseUrl(baseUrl);
  const resp = await fetch(`${base}${path}`, init);
  if (!resp.ok) {
    const message = await parseErrorResponse(resp);
    throw new Error(`HTTP ${resp.status}: ${message}`);
  }
  return resp.json();
}

export async function checkQaRunnerHealth(baseUrl) {
  return qaFetch("/health", { baseUrl });
}

export async function listSuites(baseUrl) {
  return qaFetch("/suites", { baseUrl });
}

export async function listEnvironments(baseUrl) {
  return qaFetch("/environments", { baseUrl });
}

export async function startVoiceRun({ baseUrl, caraApiUrl, environment = "local", suites }) {
  return qaFetch("/runs", {
    baseUrl,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      environment,
      baseUrl: caraApiUrl,
      suites,
    }),
  });
}

export async function getRunStatus(runId, baseUrl) {
  return qaFetch(`/runs/${runId}`, { baseUrl });
}

export async function getRunResults(runId, baseUrl) {
  return qaFetch(`/runs/${runId}/results`, { baseUrl });
}

export function getRunReportUrl(runId, baseUrl) {
  return `${getQaRunnerBaseUrl(baseUrl)}/runs/${runId}/report`;
}
