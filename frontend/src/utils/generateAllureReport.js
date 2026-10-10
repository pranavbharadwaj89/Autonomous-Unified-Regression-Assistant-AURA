/**
 * generateAllureReport.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates a fully self-contained single-file HTML report that mirrors the
 * Allure test-report style: overview stats, donut chart, suite breakdown,
 * per-test-case detail rows, and a PRISM comparison section when applicable.
 *
 * No external dependencies — all CSS and JS is inlined. The output can be
 * double-clicked from a file system to open in any browser.
 *
 * Usage:
 *   import { downloadAllureReport, downloadPrismAllureReport } from "./generateAllureReport.js";
 *
 *   // Standard regression run
 *   downloadAllureReport({ reportData, testCases, projectName });
 *
 *   // PRISM benchmark
 *   downloadPrismAllureReport({ results, models, queries, selectedLangs, projectName });
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function fmtDate(d) {
  return new Date(d || Date.now()).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── SVG donut chart ────────────────────────────────────────────────────────────

function donutSVG({ pass, fail, total, size = 120 }) {
  const r = size / 2 - 10;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const passFrac  = total > 0 ? pass / total : 0;
  const failFrac  = total > 0 ? fail / total : 1;
  const passArc   = circumference * passFrac;
  const failArc   = circumference * failFrac;
  const passOff   = 0;
  const failOff   = -(circumference - passArc);
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1e2330" stroke-width="14" />
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ef4444" stroke-width="14"
        stroke-dasharray="${circumference}" stroke-dashoffset="0"
        transform="rotate(-90 ${cx} ${cy})" />
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#10b981" stroke-width="14"
        stroke-dasharray="${passArc} ${circumference - passArc}" stroke-dashoffset="${passOff}"
        transform="rotate(-90 ${cx} ${cy})" />
      <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="#f1f5f9" font-size="18" font-weight="700" font-family="monospace">${pct(pass,total)}%</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="#94a3b8" font-size="9" font-family="monospace">PASS RATE</text>
    </svg>`;
}

// ── Bar chart (horizontal) ─────────────────────────────────────────────────────

function barChartSVG({ items, valueKey, labelKey, colorKey, maxWidth = 320, barH = 18, gap = 8 }) {
  const maxVal = Math.max(...items.map(i => i[valueKey]), 1);
  const svgH   = items.length * (barH + gap) + gap;
  const rows   = items.map((item, i) => {
    const y    = gap + i * (barH + gap);
    const w    = Math.round((item[valueKey] / maxVal) * (maxWidth - 120));
    const col  = item[colorKey] || "#00e5ff";
    const val  = typeof item[valueKey] === "number" && item[valueKey] < 1
      ? `$${item[valueKey].toFixed(5)}`
      : String(item[valueKey]);
    return `
      <text x="0" y="${y + barH - 5}" fill="#94a3b8" font-size="10" font-family="monospace">${esc(item[labelKey])}</text>
      <rect x="110" y="${y}" width="${Math.max(w, 4)}" height="${barH}" rx="3" fill="${col}" opacity="0.8" />
      <text x="${110 + Math.max(w, 4) + 6}" y="${y + barH - 5}" fill="#94a3b8" font-size="10" font-family="monospace">${val}</text>`;
  }).join("");
  return `<svg width="${maxWidth}" height="${svgH}" viewBox="0 0 ${maxWidth} ${svgH}">${rows}</svg>`;
}

// ── Main CSS ──────────────────────────────────────────────────────────────────

const ALLURE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0b0f; --surface: #111318; --surface2: #181c24; --surface3: #1e2330;
    --border: rgba(255,255,255,0.07); --border2: rgba(255,255,255,0.13);
    --accent: #00e5ff; --accent2: #7c3aed; --accent3: #10b981;
    --warn: #f59e0b; --danger: #ef4444;
    --text: #f1f5f9; --text2: #94a3b8; --text3: #475569;
    --mono: 'Courier New', monospace; --sans: system-ui, sans-serif;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; }
  a { color: var(--accent); text-decoration: none; }

  /* Layout */
  .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 20px 40px; display: flex; align-items: center; justify-content: space-between; }
  .header-logo { font-size: 22px; font-weight: 800; font-family: var(--mono); letter-spacing: -1px; }
  .header-logo span { color: var(--accent); }
  .header-meta { font-size: 12px; color: var(--text3); font-family: var(--mono); text-align: right; }
  .container { max-width: 1280px; margin: 0 auto; padding: 32px 40px; }

  /* Stats row */
  .stats-row { display: grid; grid-template-columns: auto 1fr; gap: 32px; align-items: center; margin-bottom: 32px; }
  .stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .stat-val { font-size: 28px; font-weight: 800; font-family: var(--mono); }
  .stat-label { font-size: 10px; color: var(--text3); text-transform: uppercase; letter-spacing: 1.5px; margin-top: 4px; }
  .stat-pass .stat-val { color: var(--accent3); }
  .stat-fail .stat-val { color: var(--danger); }
  .stat-total .stat-val { color: var(--accent); }
  .stat-rate .stat-val { color: var(--warn); }
  .stat-dur .stat-val { color: var(--text2); }

  /* Sections */
  .section { margin-bottom: 32px; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text3); margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }

  /* Suite cards */
  .suite-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
  .suite-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .suite-name { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .suite-bar { height: 6px; border-radius: 3px; background: var(--surface3); overflow: hidden; }
  .suite-bar-inner { height: 100%; border-radius: 3px; background: var(--accent3); }
  .suite-meta { display: flex; justify-content: space-between; margin-top: 6px; font-size: 10px; color: var(--text3); font-family: var(--mono); }

  /* Table */
  .tc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .tc-table thead th { background: var(--surface); padding: 10px 12px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text3); border-bottom: 1px solid var(--border); position: sticky; top: 0; }
  .tc-table tbody tr { border-bottom: 1px solid var(--border); transition: background 0.1s; cursor: pointer; }
  .tc-table tbody tr:hover { background: var(--surface2); }
  .tc-table tbody tr.pass { }
  .tc-table tbody tr.fail { }
  .tc-table td { padding: 9px 12px; vertical-align: middle; }
  .tc-detail { background: var(--surface2); border-bottom: 1px solid var(--border); display: none; }
  .tc-detail.open { display: table-row; }
  .tc-detail td { padding: 12px 24px; font-size: 11px; color: var(--text2); }
  .tc-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .tc-detail-item label { color: var(--text3); font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; display: block; margin-bottom: 2px; }
  .tc-detail-item span { color: var(--text); font-family: var(--mono); font-size: 11px; }
  .response-box { background: var(--surface3); border-radius: 6px; padding: 10px; font-family: var(--mono); font-size: 11px; color: var(--text2); line-height: 1.5; margin-top: 8px; white-space: pre-wrap; word-break: break-word; }

  /* Badges */
  .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; font-family: var(--mono); letter-spacing: 0.5px; }
  .badge-pass { background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
  .badge-fail { background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); }
  .intent-pill { background: rgba(0,229,255,0.08); color: #00e5ff; padding: 2px 7px; border-radius: 10px; font-size: 10px; font-family: var(--mono); border: 1px solid rgba(0,229,255,0.2); white-space: nowrap; }
  .tool-pill { background: rgba(124,58,237,0.08); color: #a78bfa; padding: 2px 7px; border-radius: 10px; font-size: 10px; font-family: var(--mono); border: 1px solid rgba(124,58,237,0.2); }
  .warn-pill { background: rgba(239,68,68,0.08); color: #ef4444; padding: 2px 7px; border-radius: 10px; font-size: 10px; font-family: var(--mono); border: 1px solid rgba(239,68,68,0.2); }

  /* PRISM sections */
  .model-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; margin-bottom: 24px; }
  .model-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 18px; }
  .model-name { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
  .model-meta { font-size: 10px; color: var(--text3); margin-bottom: 14px; }
  .metric-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 11px; }
  .metric-label { width: 100px; color: var(--text3); font-family: var(--mono); font-size: 10px; text-transform: uppercase; }
  .metric-bar-wrap { flex: 1; height: 6px; background: var(--surface3); border-radius: 3px; overflow: hidden; }
  .metric-bar-fill { height: 100%; border-radius: 3px; }
  .metric-value { width: 70px; text-align: right; font-family: var(--mono); font-size: 11px; color: var(--text2); }
  .lang-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .lang-table th, .lang-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); text-align: left; }
  .lang-table th { background: var(--surface); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text3); }

  /* Footer */
  .footer { margin-top: 48px; padding: 20px 40px; border-top: 1px solid var(--border); text-align: center; font-size: 11px; color: var(--text3); font-family: var(--mono); }
  .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; overflow-x: auto; }

  /* Trend: failure category pills */
  .cat-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .cat-pill { background: var(--surface2); border: 1px solid var(--border); border-radius: 20px; padding: 4px 12px; font-size: 11px; display: flex; align-items: center; gap: 8px; }
  .cat-count { background: var(--danger); color: #fff; border-radius: 10px; padding: 0 7px; font-size: 10px; font-weight: 700; font-family: var(--mono); }
`;

// ── Interactive JS (toggle detail rows) ───────────────────────────────────────

const ALLURE_JS = `
  document.querySelectorAll('.tc-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      const detail = document.getElementById('detail-' + id);
      if (detail) detail.classList.toggle('open');
    });
  });
  // Filter tabs
  const filterBtns = document.querySelectorAll('.filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const filter = btn.dataset.filter;
      document.querySelectorAll('.tc-row').forEach(row => {
        if (filter === 'all') { row.style.display = ''; }
        else if (filter === 'pass') { row.style.display = row.classList.contains('pass') ? '' : 'none'; }
        else { row.style.display = row.classList.contains('fail') ? '' : 'none'; }
      });
    });
  });
`;

// ── Standard Regression Report ────────────────────────────────────────────────

export function generateRegressionHTML({ reportData, testCases, projectName = "CARA" }) {
  const results  = reportData.results || {};
  const total    = reportData.total  || 0;
  const pass     = reportData.pass   || 0;
  const fail     = reportData.fail   || 0;
  const runAt    = reportData.runAt  || new Date().toISOString();

  // Group by module
  const suites = {};
  for (const tc of testCases) {
    const mod = tc.module || "General";
    if (!suites[mod]) suites[mod] = { pass: 0, fail: 0, cases: [] };
    const r = results[tc.id];
    if (r?.pass) suites[mod].pass++;
    else if (r)  suites[mod].fail++;
    suites[mod].cases.push({ tc, r });
  }

  // Failure categories
  const catMap = {};
  for (const tc of testCases) {
    const r = results[tc.id];
    if (!r || r.pass) continue;
    const cat = r.matchSource === "generic_fallback" ? "Generic Fallback"
              : !r.intentMatch ? `Intent Mismatch (${r.actualIntent})`
              : r.error ? "Error"
              : "Failed";
    catMap[cat] = (catMap[cat] || 0) + 1;
  }

  const suiteCards = Object.entries(suites).map(([mod, s]) => {
    const tot = s.pass + s.fail;
    const p   = tot > 0 ? Math.round((s.pass / tot) * 100) : 0;
    return `
      <div class="suite-card">
        <div class="suite-name" title="${esc(mod)}">${esc(mod)}</div>
        <div class="suite-bar"><div class="suite-bar-inner" style="width:${p}%"></div></div>
        <div class="suite-meta">
          <span>${s.pass} passed · ${s.fail} failed</span>
          <span>${p}%</span>
        </div>
      </div>`;
  }).join("");

  const tcRows = testCases.map((tc, i) => {
    const r  = results[tc.id];
    const st = !r ? "pending" : r.pass ? "pass" : "fail";
    const ic = r?.intentChain;
    const tk = r?.toolCheck;
    const routeOk = !tk || tk.isCorrect !== false;
    // Advanced metric colour helper
    const mc = (v) => v === null || v === undefined ? "#475569" : v >= 80 ? "#10b981" : v >= 55 ? "#f59e0b" : "#ef4444";
    const halluLabel = { clean:"Clean", low:"Low", medium:"Med", high:"High" }[r?.hallucinationLevel] ?? "—";
    const safeLabel  = r?.safetyPassed === false ? (r.safetyFlags?.some(f=>f.severity==="critical")?"Critical":"Warning") : "Safe";
    return `
      <tr class="tc-row ${st}" data-id="${i}">
        <td><span class="badge badge-${r?.pass ? "pass" : "fail"}">${r ? (r.pass ? "PASS" : "FAIL") : "—"}</span></td>
        <td style="font-family:monospace;font-size:11px;color:#94a3b8">${esc(tc.id)}</td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(tc.input)}">${esc(tc.input)}</td>
        <td><span class="intent-pill">${esc(tc.expectedIntent)}</span></td>
        <td><span class="intent-pill" style="${r?.intentMatch ? "" : "background:rgba(239,68,68,0.08);color:#ef4444;border-color:rgba(239,68,68,0.2)"}">${esc(r?.actualIntent ?? "—")}</span></td>
        <td style="font-size:10px;">
          ${ic ? `<span class="tool-pill" title="${esc(ic.chain)}">${esc(ic.tool)}</span>` : ""}
          ${!routeOk ? `<span class="warn-pill" style="margin-left:4px">⚠</span>` : ""}
        </td>
        <td style="font-family:monospace;font-size:11px;color:${r?.pass ? "#10b981" : "#ef4444"}">${r?.confidence ?? "—"}%</td>
        <td style="font-size:10px;font-family:monospace">
          ${r?.responseAccuracy !== null && r?.responseAccuracy !== undefined ? `<span style="color:${mc(r.responseAccuracy)}">RA:${r.responseAccuracy}%</span> ` : ""}
          ${r?.completenessScore !== null && r?.completenessScore !== undefined ? `<span style="color:${mc(r.completenessScore)}">C:${r.completenessScore}%</span> ` : ""}
        </td>
        <td style="font-size:10px">
          <span style="color:${r?.hallucinationLevel==="clean"||!r?.hallucinationLevel?"#10b981":"#f59e0b"}">${halluLabel}</span>
          · <span style="color:${r?.safetyPassed===false?"#ef4444":"#10b981"}">${safeLabel}</span>
        </td>
        <td style="font-size:11px;color:#475569">${r?.overallQuality !== null && r?.overallQuality !== undefined ? `<span style="color:${mc(r.overallQuality)};font-weight:700">${r.overallQuality}%</span>` : "—"}</td>
      </tr>
      <tr id="detail-${i}" class="tc-detail">
        <td colspan="10">
          <div class="tc-detail-grid">
            <div class="tc-detail-item"><label>Module</label><span>${esc(tc.module)}</span></div>
            <div class="tc-detail-item"><label>Flow</label><span>${esc(tc.flow)}</span></div>
            <div class="tc-detail-item"><label>Expected Intent</label><span>${esc(tc.expectedIntent)}</span></div>
            <div class="tc-detail-item"><label>Actual Intent</label><span>${esc(r?.actualIntent)}</span></div>
            <div class="tc-detail-item"><label>Expected Tool</label><span>${esc(ic?.tool ?? tk?.expectedTool ?? "—")}</span></div>
            <div class="tc-detail-item"><label>Handler</label><span>${esc(ic?.handler ?? "—")}</span></div>
            <div class="tc-detail-item"><label>Actual Tool</label><span style="color:${routeOk?"#10b981":"#ef4444"}">${esc(tk?.actualTool ?? "—")}</span></div>
            <div class="tc-detail-item"><label>Routing Warning</label><span style="color:#f59e0b">${esc(tk?.warning ?? "OK")}</span></div>
            <div class="tc-detail-item"><label>Resp. Accuracy</label><span style="color:${mc(r?.responseAccuracy)}">${r?.responseAccuracy ?? "—"}${r?.responseAccuracy !== null && r?.responseAccuracy !== undefined ? "%" : ""}</span></div>
            <div class="tc-detail-item"><label>Faithfulness</label><span style="color:${mc(r?.faithfulnessScore)}">${r?.faithfulnessScore ?? "—"}${r?.faithfulnessScore !== null && r?.faithfulnessScore !== undefined ? "%" : ""}</span></div>
            <div class="tc-detail-item"><label>Completeness</label><span style="color:${mc(r?.completenessScore)}">${r?.completenessScore ?? "—"}${r?.completenessScore !== null && r?.completenessScore !== undefined ? "%" : ""}</span></div>
            <div class="tc-detail-item"><label>Hallucination</label><span style="color:${r?.hallucinationLevel==="clean"||!r?.hallucinationLevel?"#10b981":"#f59e0b"}">${halluLabel}${r?.hallucinationFlags?.length ? ` (${r.hallucinationFlags.slice(0,3).join(", ")})` : ""}</span></div>
            <div class="tc-detail-item"><label>Safety</label><span style="color:${r?.safetyPassed===false?"#ef4444":"#10b981"}">${safeLabel}${r?.safetyFlags?.length ? ` — ${r.safetyFlags.map(f=>f.category).join(", ")}` : ""}</span></div>
            <div class="tc-detail-item"><label>Overall Quality</label><span style="color:${mc(r?.overallQuality)};font-weight:700">${r?.overallQuality ?? "—"}${r?.overallQuality !== null && r?.overallQuality !== undefined ? "%" : ""}</span></div>
          </div>
          <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(249,115,22,0.15)">
            <div style="font-size:10px;color:#f97316;text-transform:uppercase;letter-spacing:1px;font-family:monospace;margin-bottom:5px">E2E Agent Evaluation</div>
            <div class="tc-detail-grid">
              <div class="tc-detail-item"><label>Task Completion ★</label><span style="color:${mc(r?.taskCompletionScore)};font-weight:800">${r?.taskCompletionScore ?? "—"}${r?.taskCompletionScore !== null && r?.taskCompletionScore !== undefined ? "%" : ""}</span></div>
              <div class="tc-detail-item"><label>🧠 Reasoning Quality</label><span style="color:${mc(r?.reasoningScore)}">${r?.reasoningScore ?? "—"}${r?.reasoningScore !== null && r?.reasoningScore !== undefined ? "%" : ""}</span></div>
              <div class="tc-detail-item"><label>⚙ Tool Selection Acc.</label><span style="color:${mc(r?.toolSelectionScore)}">${r?.toolSelectionScore ?? "—"}${r?.toolSelectionScore !== null && r?.toolSelectionScore !== undefined ? "%" : ""}</span></div>
              <div class="tc-detail-item"><label>✓ Tool Execution Succ.</label><span style="color:${mc(r?.toolExecutionScore)}">${r?.toolExecutionScore ?? "—"}${r?.toolExecutionScore !== null && r?.toolExecutionScore !== undefined ? "%" : ""}</span></div>
              <div class="tc-detail-item"><label>◉ Memory Utilization</label><span style="color:${mc(r?.memoryScore)}">${r?.memoryScore !== null && r?.memoryScore !== undefined ? `${r.memoryScore}%` : "N/A"}</span></div>
            </div>
          </div>
          ${r?.message ? `<div class="response-box">${esc(r.message)}</div>` : ""}
          ${r?.error   ? `<div class="response-box" style="color:#ef4444">${esc(r.error)}</div>` : ""}
        </td>
      </tr>`;
  }).join("");

  const catPills = Object.entries(catMap).map(([cat, count]) =>
    `<div class="cat-pill"><span>${esc(cat)}</span><span class="cat-count">${count}</span></div>`
  ).join("");

  return buildHTML({
    title:    `${projectName} — Regression Report`,
    subtitle: `${total} tests · ${fmtDate(runAt)}`,
    statsHTML: `
      <div class="stats-row">
        <div>${donutSVG({ pass, fail, total })}</div>
        <div class="stats-grid">
          <div class="stat-card stat-total"><div class="stat-val">${total}</div><div class="stat-label">Total Tests</div></div>
          <div class="stat-card stat-pass"><div class="stat-val">${pass}</div><div class="stat-label">Passed</div></div>
          <div class="stat-card stat-fail"><div class="stat-val">${fail}</div><div class="stat-label">Failed</div></div>
          <div class="stat-card stat-rate"><div class="stat-val">${pct(pass,total)}%</div><div class="stat-label">Pass Rate</div></div>
          <div class="stat-card"><div class="stat-val" style="color:var(--text2)">${Object.keys(suites).length}</div><div class="stat-label">Modules</div></div>
        </div>
      </div>`,
    bodyHTML: `
      <div class="section">
        <div class="section-title">Failure Categories</div>
        <div class="cat-list">${catPills || '<span style="color:var(--text3);font-size:12px">No failures</span>'}</div>
      </div>
      <div class="section">
        <div class="section-title">Modules (${Object.keys(suites).length})</div>
        <div class="suite-grid">${suiteCards}</div>
      </div>
      <div class="section">
        <div class="section-title">
          Test Cases
          <span style="float:right;display:flex;gap:6px">
            <button class="filter-btn active" data-filter="all"  style="font-size:10px;padding:2px 8px;border-radius:4px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#94a3b8;cursor:pointer">All</button>
            <button class="filter-btn"        data-filter="pass" style="font-size:10px;padding:2px 8px;border-radius:4px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);color:#10b981;cursor:pointer">Pass</button>
            <button class="filter-btn"        data-filter="fail" style="font-size:10px;padding:2px 8px;border-radius:4px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);color:#ef4444;cursor:pointer">Fail</button>
          </span>
        </div>
        <div class="table-wrap">
          <table class="tc-table">
            <thead><tr><th>Status</th><th>TC ID</th><th>Input</th><th>Expected Intent</th><th>Actual Intent</th><th>Tool</th><th>Conf.</th><th>Quality</th><th>Risk</th><th>Overall Q.</th></tr></thead>
            <tbody>${tcRows}</tbody>
          </table>
        </div>
      </div>`,
  });
}

// ── PRISM Report ───────────────────────────────────────────────────────────────

export function generatePrismHTML({ results, models, queries, selectedLangs, projectName = "CARA" }) {
  const LANG_LABELS = {
    en:"English", hi:"Hindi", ta:"Tamil", te:"Telugu", kn:"Kannada",
    ml:"Malayalam", bn:"Bengali", mr:"Marathi", gu:"Gujarati", pa:"Punjabi",
    or:"Odia", as:"Assamese", ur:"Urdu", fr:"French", ja:"Japanese",
    es:"Spanish", zh:"Mandarin", ko:"Korean", pt:"Portuguese",
  };

  // Aggregate per model
  const summaries = models.map(m => {
    let total = 0, pass = 0, latSum = 0, costSum = 0;
    const langAcc = {};
    for (const lang of selectedLangs) {
      const rows = results[m.id]?.[lang] || [];
      const p = rows.filter(r => r.pass).length;
      langAcc[lang] = rows.length ? Math.round((p / rows.length) * 100) : 0;
      total  += rows.length;
      pass   += p;
      latSum += rows.reduce((s, r) => s + (r.latency || 0), 0);
      costSum+= rows.reduce((s, r) => s + (r.cost    || 0), 0);
    }
    return {
      model:      m,
      accuracy:   total ? Math.round((pass / total) * 100) : 0,
      avgLatency: total ? Math.round(latSum / total) : 0,
      totalCost:  costSum,
      avgCost:    total ? costSum / total : 0,
      total, pass, langAcc,
    };
  });

  const maxLat  = Math.max(...summaries.map(s => s.avgLatency), 1);
  const maxCost = Math.max(...summaries.map(s => s.avgCost), 0.000001);

  const modelCards = summaries.map(s => {
    const mc2 = (v) => !v && v !== 0 ? "#475569" : v >= 80 ? "#10b981" : v >= 55 ? "#f59e0b" : "#ef4444";
    const metricRow = (label, val, max, color, unit = "%") => val === null || val === undefined ? "" : `
      <div class="metric-row">
        <div class="metric-label">${label}</div>
        <div class="metric-bar-wrap"><div class="metric-bar-fill" style="width:${Math.min(100, Math.round((val/max)*100))}%;background:${color}"></div></div>
        <div class="metric-value" style="color:${color}">${typeof val === "number" && val < 1 ? `$${val.toFixed(5)}` : `${val}${unit}`}</div>
      </div>`;

    // Aggregate advanced metrics across all lang/query rows for this model
    const allRows = selectedLangs.flatMap(lang => results[s.model.id]?.[lang] || []);
    const avgM = (key) => { const v = allRows.map(r=>r[key]).filter(x=>x!==null&&x!==undefined); return v.length ? Math.round(v.reduce((a,b)=>a+b,0)/v.length) : null; };
    const avgRA = avgM("responseAccuracy"); const avgF = avgM("faithfulnessScore");
    const avgC  = avgM("completenessScore"); const avgH = avgM("hallucinationScore");
    const avgSaf = avgM("safetyScore"); const avgQ = avgM("overallQuality");

    return `
      <div class="model-card" style="border-color:${s.model.color}40">
        <div class="model-name" style="color:${s.model.color}">${esc(s.model.name)}</div>
        <div class="model-meta">${esc(s.model.provider)} · ${esc(s.model.apiId ?? s.model.id)}</div>
        <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:1px;margin:10px 0 6px;font-family:monospace">Performance</div>
        ${metricRow("Intent Accuracy",  s.accuracy,  100,   mc2(s.accuracy))}
        ${metricRow("Avg Latency",      s.avgLatency, maxLat,"#f59e0b"," ms")}
        ${metricRow("Avg Cost",         s.avgCost,    maxCost,"#7c3aed","")}
        <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:1px;margin:12px 0 6px;font-family:monospace">Response Quality</div>
        ${metricRow("Resp. Accuracy",   avgRA,  100, mc2(avgRA))}
        ${metricRow("Faithfulness",     avgF,   100, mc2(avgF))}
        ${metricRow("Completeness",     avgC,   100, mc2(avgC))}
        <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:1px;margin:12px 0 6px;font-family:monospace">Risk & Safety</div>
        ${metricRow("Anti-Hallucin.",   avgH,   100, mc2(avgH))}
        ${metricRow("Safety",          avgSaf,  100, mc2(avgSaf))}
        ${avgQ !== null ? `<div style="margin-top:10px;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:6px;display:flex;justify-content:space-between;align-items:center"><span style="font-size:11px;color:#94a3b8">Overall Quality ★</span><span style="font-size:16px;font-weight:800;font-family:monospace;color:${mc2(avgQ)}">${avgQ}%</span></div>` : ""}
        <!-- Agent metrics -->
        ${(() => {
          const avgTask = avgM("taskCompletionScore"); const avgRea = avgM("reasoningScore");
          const avgTSel = avgM("toolSelectionScore");  const avgTExec = avgM("toolExecutionScore");
          const avgMem  = avgM("memoryScore");
          if (!avgTask && !avgRea) return "";
          return `
            <div style="font-size:9px;color:#f97316;text-transform:uppercase;letter-spacing:1px;margin:14px 0 6px;font-family:monospace;border-top:1px solid rgba(249,115,22,0.2);padding-top:10px">E2E Agent Evaluation</div>
            ${avgTask  !== null ? metricRow("★ Task Completion",  avgTask,  100, mc2(avgTask))  : ""}
            ${avgRea   !== null ? metricRow("🧠 Reasoning",       avgRea,   100, mc2(avgRea))   : ""}
            ${avgTSel  !== null ? metricRow("⚙ Tool Selection",   avgTSel,  100, mc2(avgTSel))  : ""}
            ${avgTExec !== null ? metricRow("✓ Tool Execution",   avgTExec, 100, mc2(avgTExec)) : ""}
            ${avgMem   !== null ? metricRow("◉ Memory",           avgMem,   100, mc2(avgMem))   : ""}
          `;
        })()}
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:16px;font-size:11px">
          <span><span style="color:#10b981;font-weight:700;font-family:monospace">${s.pass}</span> <span style="color:#475569">pass</span></span>
          <span><span style="color:#ef4444;font-weight:700;font-family:monospace">${s.total - s.pass}</span> <span style="color:#475569">fail</span></span>
          <span style="margin-left:auto;color:#475569">Total: <span style="font-family:monospace;color:#94a3b8">$${s.totalCost.toFixed(4)}</span></span>
        </div>
      </div>`;
  }).join("");

  // Language breakdown table
  const langHeaderCells = models.map(m =>
    `<th style="color:${m.color}">${esc(m.name)}</th>`
  ).join("");
  const langRows = selectedLangs.map(lang => {
    const label = LANG_LABELS[lang] || lang;
    const cells = models.map(m => {
      const s = summaries.find(x => x.model.id === m.id);
      const acc = s?.langAcc[lang] ?? 0;
      const col = acc >= 80 ? "#10b981" : acc >= 55 ? "#f59e0b" : "#ef4444";
      return `<td><span style="font-family:monospace;color:${col};font-weight:700">${acc}%</span></td>`;
    }).join("");
    return `<tr><td>${esc(label)}</td>${cells}</tr>`;
  }).join("");

  // Per-query detail table
  const pmc = (v) => v === null || v === undefined ? "#475569" : v >= 80 ? "#10b981" : v >= 55 ? "#f59e0b" : "#ef4444";
  const detailRows = queries.flatMap(q =>
    selectedLangs.map(lang => {
      const label = LANG_LABELS[lang] || lang;
      const cells = models.map(m => {
        const r = results[m.id]?.[lang]?.find(x => x.queryId === q.id);
        if (!r) return `<td style="color:#475569">—</td>`;
        const halluLabel = { clean:"Clean", low:"Low", medium:"Med", high:"High" }[r.hallucinationLevel] ?? "—";
        const safeLabel  = r.safetyPassed === false ? "⚠ Unsafe" : "Safe";
        const safeColor  = r.safetyPassed === false ? "#ef4444" : "#10b981";
        return `<td>
          <span class="badge badge-${r.pass ? "pass" : "fail"}">${r.pass ? "PASS" : "FAIL"}</span>
          <div style="font-size:10px;color:#475569;font-family:monospace;margin-top:3px">${r.latency}ms · $${r.cost?.toFixed(5)}</div>
          <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px">
            ${r.responseAccuracy !== null && r.responseAccuracy !== undefined ? `<span style="font-size:9px;font-family:monospace;color:${pmc(r.responseAccuracy)}">RA:${r.responseAccuracy}%</span>` : ""}
            ${r.completenessScore !== null && r.completenessScore !== undefined ? `<span style="font-size:9px;font-family:monospace;color:${pmc(r.completenessScore)}">C:${r.completenessScore}%</span>` : ""}
            <span style="font-size:9px;font-family:monospace;color:${r.hallucinationLevel==="clean"?"#10b981":"#f59e0b"}">H:${halluLabel}</span>
            <span style="font-size:9px;font-family:monospace;color:${safeColor}">${safeLabel}</span>
            ${r.overallQuality !== null && r.overallQuality !== undefined ? `<span style="font-size:9px;font-family:monospace;color:${pmc(r.overallQuality)};font-weight:700">Q:${r.overallQuality}%</span>` : ""}
          </div>
        </td>`;
      }).join("");
      return `<tr>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" title="${esc(q.query)}">${esc(q.query)}</td>
        <td><span class="intent-pill">${esc(q.expectedIntent)}</span></td>
        <td style="font-size:11px">${esc(label)}</td>
        ${cells}
      </tr>`;
    })
  ).join("");
  const detailHeaderCells = models.map(m => `<th style="color:${m.color}">${esc(m.name)}</th>`).join("");

  return buildHTML({
    title:    `${projectName} — PRISM Benchmark Report`,
    subtitle: `${models.length} models · ${selectedLangs.length} languages · ${queries.length} queries · ${fmtDate(null)}`,
    statsHTML: `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:24px">
        <div class="stat-card stat-total"><div class="stat-val">${models.length}</div><div class="stat-label">Models Tested</div></div>
        <div class="stat-card stat-pass"><div class="stat-val">${selectedLangs.length}</div><div class="stat-label">Languages</div></div>
        <div class="stat-card stat-rate"><div class="stat-val">${queries.length}</div><div class="stat-label">Test Queries</div></div>
        <div class="stat-card stat-fail"><div class="stat-val">${models.length * selectedLangs.length * queries.length}</div><div class="stat-label">Total API Calls</div></div>
      </div>`,
    bodyHTML: `
      <div class="section">
        <div class="section-title">Model Summary</div>
        <div class="model-grid">${modelCards}</div>
      </div>
      <div class="section">
        <div class="section-title">Language Breakdown</div>
        <div class="table-wrap">
          <table class="lang-table">
            <thead><tr><th>Language</th>${langHeaderCells}</tr></thead>
            <tbody>${langRows}</tbody>
          </table>
        </div>
      </div>
      <div class="section">
        <div class="section-title">Per-Query Results</div>
        <div class="table-wrap">
          <table class="tc-table">
            <thead><tr><th>Query</th><th>Expected Intent</th><th>Language</th>${detailHeaderCells}</tr></thead>
            <tbody>${detailRows}</tbody>
          </table>
        </div>
      </div>`,
  });
}

// ── Shared HTML shell ─────────────────────────────────────────────────────────

function buildHTML({ title, subtitle, statsHTML, bodyHTML }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<style>${ALLURE_CSS}</style>
</head>
<body>
<div class="header">
  <div>
    <div class="header-logo">CARA <span>·</span> Test Report</div>
    <div style="font-size:12px;color:#475569;margin-top:3px;font-family:monospace">${esc(title)}</div>
  </div>
  <div class="header-meta">
    Generated ${fmtDate(null)}<br/>
    ${esc(subtitle)}
  </div>
</div>
<div class="container">
  ${statsHTML}
  ${bodyHTML}
</div>
<div class="footer">
  CARA Automation Suite · Report generated ${fmtDate(null)} · Powered by PRISM Evaluation Engine
</div>
<script>${ALLURE_JS}</script>
</body>
</html>`;
}

// ── Download helpers ──────────────────────────────────────────────────────────

export function downloadAllureReport({ reportData, testCases, projectName }) {
  const html = generateRegressionHTML({ reportData, testCases, projectName });
  triggerDownload(html, `CARA_Report_${new Date().toISOString().slice(0,10)}.html`);
}

export function downloadPrismAllureReport({ results, models, queries, selectedLangs, projectName }) {
  const html = generatePrismHTML({ results, models, queries, selectedLangs, projectName });
  triggerDownload(html, `PRISM_Report_${new Date().toISOString().slice(0,10)}.html`);
}

/** Judge LLM evaluation — Allure-style single-file HTML from /judge/run-evaluation response */
export function downloadJudgeAllureReport({ allure, summary, meta, projectName }) {
  const rows = allure?.rows || [];
  const pass = summary?.pass ?? 0;
  const partial = summary?.partial ?? 0;
  const fail = summary?.fail ?? 0;
  const total = summary?.total ?? rows.length;

  const tableRows = rows.map((row, i) => `
    <tr>
      <td>${esc(row.test_scenario)}</td>
      <td class="wrap">${esc(row.expected_result)}</td>
      <td class="wrap">${esc(row.newly_generated_expected_result)}</td>
      <td class="wrap">${esc(row.actual_result)}</td>
      <td class="num">${esc(row.accuracy)}</td>
      <td class="num">${esc(row.intent)}</td>
      <td class="num">${esc(row.efficiency)}</td>
      <td class="status-${String(row.status).toLowerCase()}">${esc(row.status)}</td>
      <td class="num">${esc(row.consolidated_percentage)}</td>
    </tr>
    <tr class="just-row">
      <td colspan="9" style="font-size:11px;color:#64748b;padding:4px 8px 12px">
        <strong>Justifications:</strong>
        Accuracy — ${esc(row.accuracy_justification || "—")} ·
        Intent — ${esc(row.intent_justification || "—")} ·
        Efficiency — ${esc(row.efficiency_justification || "—")}
      </td>
    </tr>`).join("");

  const statsHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-val">${total}</div><div class="stat-lbl">Total</div></div>
      <div class="stat-card pass"><div class="stat-val">${pass}</div><div class="stat-lbl">Pass</div></div>
      <div class="stat-card warn"><div class="stat-val">${partial}</div><div class="stat-lbl">Partial</div></div>
      <div class="stat-card fail"><div class="stat-val">${fail}</div><div class="stat-lbl">Fail</div></div>
      <div class="stat-card"><div class="stat-val">${summary?.avg_consolidated_percentage ?? 0}%</div><div class="stat-lbl">Avg Consolidated</div></div>
    </div>`;

  const bodyHTML = `
    <style>
      .wrap { max-width: 240px; white-space: pre-wrap; word-break: break-word; font-size: 11px; }
      .num { text-align: right; font-family: monospace; }
      .status-pass { color: #10b981; font-weight: 700; }
      .status-partial { color: #f59e0b; font-weight: 700; }
      .status-fail { color: #ef4444; font-weight: 700; }
      .just-row td { border-top: none !important; }
    </style>
    <div class="section">
      <div class="section-title">Judge LLM Results</div>
      <div class="table-wrap">
        <table class="tc-table">
          <thead><tr>
            <th>Test Scenario</th><th>Expected Result</th><th>Newly Generated Expected</th>
            <th>Actual Result</th><th>Accuracy</th><th>Intent</th><th>Efficiency</th>
            <th>Status</th><th>Consolidated %</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <p style="font-size:12px;color:#64748b;margin-top:16px">
        Executor: ${esc(meta?.executor_model)} · Judge: ${esc(meta?.judge_model)}
      </p>
    </div>`;

  const html = buildHTML({
    title: projectName || "Judge LLM Evaluation",
    subtitle: "Judge LLM · Parallel Executor + Scoring",
    statsHTML,
    bodyHTML,
  });
  triggerDownload(html, `Judge_LLM_Report_${new Date().toISOString().slice(0, 10)}.html`);
}

function triggerDownload(html, filename) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const a    = document.createElement("a");
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
