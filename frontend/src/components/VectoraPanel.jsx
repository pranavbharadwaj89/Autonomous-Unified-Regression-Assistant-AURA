import { useState, useRef, useCallback, useEffect } from "react";

const API = "/api/v1/vectora";

async function apiPost(path, body, isForm = false, signal = undefined) {
  const opts = isForm
    ? { method: "POST", body, signal }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal };
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function Badge({ text, color = "var(--accent)" }) {
  return (
    <span style={{
      fontFamily: "var(--mono)", fontSize: 9, fontWeight: 700, padding: "2px 6px",
      borderRadius: 3, background: `${color}22`, color, border: `1px solid ${color}44`,
      letterSpacing: "0.5px", textTransform: "uppercase",
    }}>{text}</span>
  );
}

function ScoreBar({ value, max = 1 }) {
  const pct = Math.round((value / max) * 100);
  const color = pct >= 80 ? "var(--accent3)" : pct >= 50 ? "var(--warn)" : "var(--danger)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 4, background: "var(--surface3)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.4s ease" }} />
      </div>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color, minWidth: 36, textAlign: "right" }}>
        {(value * 100).toFixed(0)}%
      </span>
    </div>
  );
}

function ChunkCard({ chunk, rank }) {
  const [expanded, setExpanded] = useState(false);
  const sim = chunk.rerank_score ?? chunk.similarity ?? 0;
  const simPct = Math.round(sim * 100);
  const simColor = simPct >= 80 ? "var(--accent3)" : simPct >= 50 ? "var(--warn)" : "var(--text3)";
  return (
    <div style={{
      background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8,
      padding: "12px 14px", cursor: "pointer", transition: "border-color 0.15s",
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = "var(--border2)"}
      onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border)"}
      onClick={() => setExpanded(x => !x)}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{
          width: 24, height: 24, borderRadius: 4, background: "var(--surface3)",
          border: "1px solid var(--border2)", display: "flex", alignItems: "center",
          justifyContent: "center", fontFamily: "var(--mono)", fontSize: 10,
          color: "var(--text3)", flexShrink: 0,
        }}>{rank}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
            {chunk.section_title && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent2)" }}>{chunk.section_title}</span>
            )}
            {chunk.page_number && (
              <span style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)" }}>p.{chunk.page_number}</span>
            )}
            <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 11, color: simColor, fontWeight: 700 }}>
              {simPct}%
            </span>
            {chunk.llm_score != null && (
              <Badge text={`LLM ${Math.round(chunk.llm_score * 100)}%`} color="var(--accent2)" />
            )}
          </div>
          <p style={{
            fontSize: 12, color: "var(--text2)", lineHeight: 1.6, margin: 0,
            overflow: "hidden", display: "-webkit-box", WebkitLineClamp: expanded ? "unset" : 2,
            WebkitBoxOrient: "vertical",
          }}>{chunk.text}</p>
          {!expanded && chunk.text.length > 200 && (
            <span style={{ fontSize: 10, color: "var(--accent)", fontFamily: "var(--mono)" }}>show more ↓</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── TAB: Ingest ────────────────────────────────────────────────────────────────

function IngestTab({ onLog }) {
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("Ingesting…");
  const [result, setResult] = useState(null);
  const [sections, setSections] = useState(null);
  const [sectionsLoading, setSectionsLoading] = useState(false);
  const inputRef = useRef(null);

  async function loadSectionMetadata(docId) {
    setSectionsLoading(true);
    try {
      const res = await fetch(`${API}/section-metadata?source_document_id=${encodeURIComponent(docId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSections(data);
    } catch (e) {
      onLog("err", `Section metadata failed: ${e.message}`);
    } finally {
      setSectionsLoading(false);
    }
  }

  async function uploadFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["pdf", "docx", "txt"].includes(ext)) {
      onLog("err", `Unsupported file type: .${ext}`);
      return;
    }
    const sizeMB = file.size / (1024 * 1024);
    const isLarge = sizeMB > 2;
    setLoading(true);
    setLoadingMsg(isLarge
      ? `Chunking & embedding ${sizeMB.toFixed(1)} MB — this may take 1–3 minutes…`
      : "Ingesting…"
    );
    setResult(null);
    setSections(null);
    onLog("info", `Ingesting: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 300_000); // 5 min
      const data = await apiPost("/ingest", fd, true, controller.signal);
      clearTimeout(tid);
      setResult(data);
      onLog("ok", `✓ Ingested "${file.name}" → ${data.chunk_count} chunks · doc_id: ${data.source_document_id.slice(0, 8)}…`);
      if (data.source_document_id && data.chunk_count > 0) {
        loadSectionMetadata(data.source_document_id);
      }
    } catch (e) {
      onLog("err", `Ingest failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  function onDrop(e) {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        className={`upload-zone ${dragging ? "drag" : ""}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept=".pdf,.docx,.txt" style={{ display: "none" }}
          onChange={e => { const f = e.target.files[0]; if (f) uploadFile(f); e.target.value = ""; }} />
        <div className="upload-icon">📄</div>
        <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
          {loading ? loadingMsg : "Drop a document or click to browse"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text3)" }}>PDF · DOCX · TXT</div>
        {loading && <div style={{ marginTop: 12 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>}
      </div>

      {result && (
        <div className="card" style={{ background: "var(--surface2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 16 }}>✅</span>
            <span style={{ fontWeight: 700, color: "var(--text)" }}>{result.filename}</span>
            <Badge text={result.status} color={result.status === "ready" ? "var(--accent3)" : "var(--warn)"} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {[
              ["Chunks", result.chunk_count],
              ["Model", result.embedding_model?.split("/").pop() || "—"],
              ["Doc ID", result.source_document_id?.slice(0, 16) + "…"],
              ["Status", result.status],
            ].map(([k, v]) => (
              <div key={k} style={{ background: "var(--surface3)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.8px", fontFamily: "var(--mono)", marginBottom: 4 }}>{k}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--accent)", wordBreak: "break-all" }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div className="card" style={{ background: "var(--surface2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 16 }}>🗂️</span>
            <span style={{ fontWeight: 700, color: "var(--text)" }}>Chunking metadata by section</span>
            {sections && <Badge text={`${sections.section_count} sections`} />}
          </div>
          {sectionsLoading && (
            <div style={{ display: "flex", justifyContent: "center", padding: 12 }}><div className="spinner" /></div>
          )}
          {!sectionsLoading && sections && sections.sections.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Section", "Chunks", "Total tokens", "Avg tokens", "Pages"].map(h => (
                      <th key={h} style={{
                        textAlign: "left", padding: "6px 10px", color: "var(--text3)",
                        fontFamily: "var(--mono)", fontSize: 10, textTransform: "uppercase",
                        letterSpacing: "0.6px",
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sections.sections.map((s, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "6px 10px", color: "var(--text)" }}>
                        {s.section_title || <em style={{ color: "var(--text3)" }}>(no heading)</em>}
                      </td>
                      <td style={{ padding: "6px 10px", color: "var(--accent)", fontFamily: "var(--mono)" }}>{s.chunk_count}</td>
                      <td style={{ padding: "6px 10px", color: "var(--text2)", fontFamily: "var(--mono)" }}>{s.total_tokens}</td>
                      <td style={{ padding: "6px 10px", color: "var(--text2)", fontFamily: "var(--mono)" }}>{s.avg_tokens != null ? s.avg_tokens.toFixed(0) : "—"}</td>
                      <td style={{ padding: "6px 10px", color: "var(--text3)", fontFamily: "var(--mono)" }}>
                        {s.min_page != null ? (s.min_page === s.max_page ? `p.${s.min_page}` : `p.${s.min_page}–${s.max_page}`) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!sectionsLoading && sections && sections.sections.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text3)" }}>No section metadata available.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── TAB: Search ────────────────────────────────────────────────────────────────

function SearchTab({ onLog }) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [docId, setDocId] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);

  async function runSearch() {
    if (!query.trim()) return;
    setLoading(true); setResults(null);
    onLog("info", `Search: "${query}" top_k=${topK}`);
    try {
      const data = await apiPost("/search", {
        query, top_k: topK,
        source_document_id: docId.trim() || null,
      });
      setResults(data);
      onLog("ok", `Search returned ${data.count} results`);
    } catch (e) {
      onLog("err", `Search failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div className="stack" style={{ gap: 12 }}>
          <div className="form-group">
            <label className="form-label">Query</label>
            <div style={{ display: "flex", gap: 8 }}>
              <textarea className="form-textarea" rows={2} value={query} onChange={e => setQuery(e.target.value)}
                placeholder="What does the document say about…"
                onKeyDown={e => { if (e.key === "Enter" && e.metaKey) runSearch(); }}
                style={{ flex: 1 }} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Top K</label>
              <input className="form-input" type="number" min={1} max={20} value={topK}
                onChange={e => setTopK(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label className="form-label">Doc ID (optional)</label>
              <input className="form-input" value={docId} onChange={e => setDocId(e.target.value)}
                placeholder="Filter to one document" />
            </div>
          </div>
          <button className="btn btn-primary" onClick={runSearch} disabled={loading || !query.trim()}>
            {loading ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Searching…</> : "Search"}
          </button>
        </div>
      </div>

      {results && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text3)" }}>
              {results.count} result{results.count !== 1 ? "s" : ""} for
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", fontStyle: "italic" }}>"{results.query}"</span>
          </div>
          {results.results.length === 0
            ? <div className="empty"><div className="empty-icon">🔍</div><p>No matching chunks found.</p></div>
            : results.results.map((c, i) => <ChunkCard key={c.chunk_id} chunk={c} rank={i + 1} />)
          }
        </div>
      )}
    </div>
  );
}

// ── TAB: Query Pipeline ────────────────────────────────────────────────────────

function QueryTab({ onLog }) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [docId, setDocId] = useState("");
  const [withMeta, setWithMeta] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [contextExpanded, setContextExpanded] = useState(false);

  async function runQuery() {
    if (!query.trim()) return;
    setLoading(true); setResult(null);
    onLog("info", `Query pipeline: "${query}" top_k=${topK} reranker=on`);
    try {
      const data = await apiPost("/query", {
        query, top_k: topK,
        source_document_id: docId.trim() || null,
        include_metadata: withMeta,
      });
      setResult(data);
      onLog("ok", `Pipeline complete: ${data.chunks.length} chunks · reranker_used=${data.reranker_used} · retrieved=${data.retrieval_count}`);
    } catch (e) {
      onLog("err", `Query failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div className="stack" style={{ gap: 12 }}>
          <div className="form-group">
            <label className="form-label">Query</label>
            <textarea className="form-textarea" rows={2} value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Ask a question about your ingested documents…" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Top K</label>
              <input className="form-input" type="number" min={1} max={20} value={topK}
                onChange={e => setTopK(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label className="form-label">Doc ID (optional)</label>
              <input className="form-input" value={docId} onChange={e => setDocId(e.target.value)} placeholder="Scope to document" />
            </div>
            <div className="form-group">
              <label className="form-label">Section Headers</label>
              <button className={`btn ${withMeta ? "btn-primary" : "btn-secondary"}`}
                style={{ marginTop: 2 }} onClick={() => setWithMeta(x => !x)}>
                {withMeta ? "✓ Enabled" : "Off"}
              </button>
            </div>
          </div>
          <button className="btn btn-primary" onClick={runQuery} disabled={loading || !query.trim()}>
            {loading ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Running pipeline…</> : "▶ Run Query Pipeline"}
          </button>
        </div>
      </div>

      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
            {[
              ["Retrieved", result.retrieval_count, "var(--accent)"],
              ["Reranked to", result.chunks.length, "var(--accent2)"],
              ["Reranker", result.reranker_used ? "LLM ✓" : "Vec only", result.reranker_used ? "var(--accent3)" : "var(--warn)"],
              ["Model", result.metadata?.embedding_model?.split("/").pop() || "—", "var(--text2)"],
            ].map(([k, v, c]) => (
              <div key={k} style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.8px", fontFamily: "var(--mono)", marginBottom: 4 }}>{k}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: c, fontWeight: 700 }}>{v}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)" }}>Assembled Context</span>
              <div style={{ display: "flex", gap: 6 }}>
                <Badge text="LLM-ready" color="var(--accent3)" />
                <button className="btn btn-secondary" style={{ fontSize: 10, padding: "3px 10px" }}
                  onClick={() => setContextExpanded(x => !x)}>
                  {contextExpanded ? "Collapse" : "Expand"}
                </button>
                <button className="btn btn-secondary" style={{ fontSize: 10, padding: "3px 10px" }}
                  onClick={() => navigator.clipboard?.writeText(result.context)}>
                  Copy
                </button>
              </div>
            </div>
            <div style={{
              background: "#090b0e", border: "1px solid var(--border)", borderRadius: 6, padding: 12,
              fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent3)", whiteSpace: "pre-wrap",
              wordBreak: "break-word", maxHeight: contextExpanded ? "none" : 180, overflow: "auto",
            }}>
              {result.context || "(empty — no chunks returned)"}
            </div>
          </div>

          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text3)", marginBottom: 10 }}>
              Ranked chunks — sorted by rerank score
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {result.chunks.map((c, i) => <ChunkCard key={c.chunk_id} chunk={c} rank={i + 1} />)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TAB: Eval Log ──────────────────────────────────────────────────────────────

function EvalLogTab({ onLog }) {
  const [form, setForm] = useState({ query_text: "", retrieved_chunk_ids: "", score: "", feedback: "" });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function submit() {
    if (!form.query_text.trim()) return;
    setLoading(true); setResult(null);
    try {
      const ids = form.retrieved_chunk_ids.split(",").map(s => s.trim()).filter(Boolean);
      const score = form.score ? parseFloat(form.score) : null;
      const data = await apiPost("/eval-log", {
        query_text: form.query_text,
        retrieved_chunk_ids: ids,
        score,
        feedback: form.feedback || null,
      });
      setResult(data);
      onLog("ok", `Evaluation logged: id=${data.log_id?.slice(0, 12)}…`);
    } catch (e) {
      onLog("err", `Eval log failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div className="stack" style={{ gap: 12 }}>
          <div className="form-group">
            <label className="form-label">Query Text</label>
            <textarea className="form-textarea" rows={2} value={form.query_text}
              onChange={e => setForm(p => ({ ...p, query_text: e.target.value }))}
              placeholder="The query that was evaluated" />
          </div>
          <div className="form-group">
            <label className="form-label">Retrieved Chunk IDs (comma-separated)</label>
            <input className="form-input" value={form.retrieved_chunk_ids}
              onChange={e => setForm(p => ({ ...p, retrieved_chunk_ids: e.target.value }))}
              placeholder="uuid1, uuid2, …" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Score (0.0 – 1.0)</label>
              <input className="form-input" type="number" min={0} max={1} step={0.01}
                value={form.score} onChange={e => setForm(p => ({ ...p, score: e.target.value }))}
                placeholder="0.85" />
            </div>
            <div className="form-group">
              <label className="form-label">Feedback</label>
              <input className="form-input" value={form.feedback}
                onChange={e => setForm(p => ({ ...p, feedback: e.target.value }))}
                placeholder="Optional free-text feedback" />
            </div>
          </div>
          <button className="btn btn-primary" onClick={submit} disabled={loading || !form.query_text.trim()}>
            {loading ? "Logging…" : "Log Evaluation"}
          </button>
        </div>
      </div>

      {result && (
        <div style={{ background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.25)", borderRadius: 8, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>✅</span>
            <span style={{ fontWeight: 700, color: "var(--accent3)" }}>Logged</span>
            <Badge text={result.status} color="var(--accent3)" />
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text3)", marginTop: 8 }}>
            log_id: {result.log_id}
          </div>
        </div>
      )}
    </div>
  );
}

// ── TAB: Batch Evaluate ──────────────────────────────────────────────────────

function ScorePill({ label, value }) {
  if (value == null) return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text3)" }}>{label}: —</span>
  );
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? "var(--accent3)" : pct >= 40 ? "var(--warn)" : "var(--danger)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 11, color }}>
      {label}: <b>{pct}%</b>
    </span>
  );
}

function VerdictBadge({ verdict }) {
  if (!verdict) return null;
  const pass = verdict === "pass";
  return <Badge text={pass ? "✓ PASS" : "✗ FAIL"} color={pass ? "var(--accent3)" : "var(--danger)"} />;
}

function BatchRow({ row }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer" }}
        onClick={() => setOpen(o => !o)}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {row.test_case_id && <Badge text={row.test_case_id} color="var(--accent2)" />}
            <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 360 }}>
              {row.query}
            </span>
          </div>
        </div>
        <ScorePill label="intent(ret)" value={row.evidence_retrieval_score} />
        <ScorePill label="intent(exp)" value={row.evidence_expected_score} />
        <ScorePill label="rel" value={row.relevance_score} />
        <ScorePill label="exp" value={row.expected_match_score} />
        {row.primary_page != null && (
          <Badge text={`p.${row.primary_page}`} color="var(--accent)" />
        )}
        <VerdictBadge verdict={row.verdict} />
        <span style={{ fontSize: 10, color: "var(--accent)", fontFamily: "var(--mono)" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          {row.expected_answer && (
            <div>
              <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3 }}>Expected Answer</div>
              <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.5 }}>{row.expected_answer}</div>
            </div>
          )}
          {row.reasoning && (
            <div>
              <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3 }}>Judge Reasoning</div>
              <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.5, fontStyle: "italic" }}>{row.reasoning}</div>
            </div>
          )}
          {row.evidence_text && (
            <div>
              <div style={{ fontSize: 10, color: "var(--accent3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>
                🧾 Hard Evidence{row.primary_page != null ? ` — p.${row.primary_page}` : ""}
                {row.evidence_pages?.length > 1 ? ` (pages ${row.evidence_pages.join(", ")})` : ""}
                {" · authoritative source · judge ground truth"}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text2)", lineHeight: 1.55, whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto", background: "var(--surface)", border: "1px solid var(--accent3)", borderRadius: 6, padding: "8px 10px" }}>
                {row.evidence_text}
              </div>
            </div>
          )}
          <div>
            <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>
              Retrieved Chunks ({row.chunks.length} · {row.retrieval_count} candidates · reranker {row.reranker_used ? "on" : "off"})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {row.chunks.length === 0
                ? <div style={{ fontSize: 11, color: "var(--text3)" }}>No chunks retrieved — ingest documents first.</div>
                : row.chunks.map((c, i) => <ChunkCard key={c.chunk_id} chunk={c} rank={i + 1} />)
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BatchEvalTab({ onLog }) {
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [data, setData] = useState(null);
  const [topK, setTopK] = useState(5);
  const [docId, setDocId] = useState("");
  const inputRef = useRef(null);

  const EXCEL = ["xlsx", "xlsm"];
  const AUDIO = ["mp3", "wav", "m4a", "mp4", "mpeg", "mpga", "webm", "ogg"];

  async function uploadFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (![...EXCEL, ...AUDIO].includes(ext)) {
      onLog("err", `Unsupported file: .${ext}. Use .xlsx or an audio file.`);
      return;
    }
    const isAudio = AUDIO.includes(ext);
    setLoading(true);
    setData(null);
    setLoadingMsg(isAudio
      ? "Transcribing audio & evaluating…"
      : "Parsing Excel & evaluating each query (embed → retrieve → rerank → judge)…");
    onLog("info", `Batch eval: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const qs = new URLSearchParams({ top_k: String(topK) });
      if (docId.trim()) qs.set("source_document_id", docId.trim());
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 300_000);
      const res = await fetch(`${API}/evaluate-batch?${qs.toString()}`, {
        method: "POST", body: fd, signal: controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      const s = json.summary;
      const pct = (v) => v != null ? Math.round(v * 100) + "%" : "—";
      onLog("ok", `✓ Evaluated ${s.count} ${json.source === "audio" ? "query" : "queries"} · avg intent(ret) ${pct(s.avg_evidence_retrieval)} · intent(exp) ${pct(s.avg_evidence_expected)} · ${s.pass_count} pass / ${s.fail_count} fail`);
    } catch (e) {
      onLog("err", `Batch eval failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  function onDrop(e) {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) uploadFile(f);
  }

  const s = data?.summary;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* config */}
      <div className="card">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
          <div className="form-group">
            <label className="form-label">Top K per query</label>
            <input className="form-input" type="number" min={1} max={20} value={topK}
              onChange={e => setTopK(Number(e.target.value))} />
          </div>
          <div className="form-group">
            <label className="form-label">Doc ID (optional — scope retrieval)</label>
            <input className="form-input" value={docId} onChange={e => setDocId(e.target.value)}
              placeholder="Restrict to one ingested document" />
          </div>
        </div>
      </div>

      {/* upload zone */}
      <div
        className={`upload-zone ${dragging ? "drag" : ""}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept=".xlsx,.xlsm,.mp3,.wav,.m4a,.mp4,.webm,.ogg" style={{ display: "none" }}
          onChange={e => { const f = e.target.files[0]; if (f) uploadFile(f); e.target.value = ""; }} />
        <div className="upload-icon">🧪</div>
        <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
          {loading ? loadingMsg : "Drop an Excel of queries or an audio file"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text3)" }}>
          XLSX (Voice Input + Expected Response, RAG_Model rows) · Audio (mp3/wav/m4a…)
        </div>
        {loading && <div style={{ marginTop: 12 }}><div className="spinner" style={{ margin: "0 auto" }} /></div>}
      </div>

      {/* summary + results */}
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
            {[
              ["Source", data.source, "var(--accent2)"],
              ["Queries", s.count, "var(--accent)"],
              ["Avg Intent (ret)", s.avg_evidence_retrieval != null ? Math.round(s.avg_evidence_retrieval * 100) + "%" : "—", "var(--accent)"],
              ["Avg Intent (exp)", s.avg_evidence_expected != null ? Math.round(s.avg_evidence_expected * 100) + "%" : "—", "var(--accent)"],
              ["Avg Relevance", s.avg_relevance != null ? Math.round(s.avg_relevance * 100) + "%" : "—", "var(--accent3)"],
              ["Avg Expected", s.avg_expected_match != null ? Math.round(s.avg_expected_match * 100) + "%" : "—", "var(--accent3)"],
              ["Pass / Fail", `${s.pass_count} / ${s.fail_count}`, s.fail_count === 0 ? "var(--accent3)" : "var(--warn)"],
            ].map(([k, v, c]) => (
              <div key={k} style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: "var(--mono)", marginBottom: 4 }}>{k}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: c, fontWeight: 700 }}>{v}</div>
              </div>
            ))}
          </div>

          {/* excel parse info / transcript */}
          {data.source === "audio" && data.info?.transcript && (
            <div className="card" style={{ background: "var(--surface2)" }}>
              <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>Transcript</div>
              <div style={{ fontSize: 13, color: "var(--text)" }}>{data.info.transcript}</div>
            </div>
          )}
          {data.source === "excel" && data.info?.detected && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text3)" }}>
              Detected → query: <b style={{ color: "var(--accent2)" }}>{data.info.detected.query_col || "?"}</b>
              {" · "}expected: <b style={{ color: "var(--accent2)" }}>{data.info.detected.expected_col || "—"}</b>
              {data.info.untagged_skipped > 0 && <> · skipped {data.info.untagged_skipped} untagged rows</>}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.rows.length === 0
              ? <div className="empty"><div className="empty-icon">📭</div><p>No rows evaluated. Check the RAG_Model tag and the query column.</p></div>
              : data.rows.map((r, i) => <BatchRow key={r.row_number ?? i} row={r} />)
            }
          </div>
        </div>
      )}
    </div>
  );
}

// ── TAB: Golden Evaluate ─────────────────────────────────────────────────────

function PageHitPills({ expected = [], retrieved = [], hit = [] }) {
  const hitSet = new Set(hit);
  const expSet = new Set(expected);
  const lbl = { fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3 };
  return (
    <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
      <div>
        <div style={lbl}>Golden pages (expected)</div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {expected.length ? expected.map(p =>
            <Badge key={p} text={`p.${p}`} color={hitSet.has(p) ? "var(--accent3)" : "var(--danger)"} />
          ) : <span style={{ fontSize: 11, color: "var(--text3)" }}>—</span>}
        </div>
      </div>
      <div>
        <div style={lbl}>Retrieved pages</div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {retrieved.length ? retrieved.map((p, i) =>
            <Badge key={`${p}-${i}`} text={`p.${p}`} color={expSet.has(p) ? "var(--accent3)" : "var(--text3)"} />
          ) : <span style={{ fontSize: 11, color: "var(--text3)" }}>none</span>}
        </div>
      </div>
    </div>
  );
}

function GoldenRow({ row }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer" }}
        onClick={() => setOpen(o => !o)}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Badge text={row.case_id} color="var(--accent2)" />
            {row.intent_type === "multi_intent" && <Badge text="multi" color="var(--warn)" />}
            <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 300 }}>
              {row.query}
            </span>
          </div>
        </div>
        <Badge text={row.page_hit ? "✓ page" : "✗ page"} color={row.page_hit ? "var(--accent3)" : "var(--danger)"} />
        <ScorePill label="acc" value={row.answer_accuracy} />
        <VerdictBadge verdict={row.verdict} />
        <span style={{ fontSize: 10, color: "var(--accent)", fontFamily: "var(--mono)" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <PageHitPills expected={row.expected_pages} retrieved={row.retrieved_pages} hit={row.hit_pages} />
          {row.expected_section && (
            <div>
              <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3 }}>Golden expected section</div>
              <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.5 }}>{row.expected_section}</div>
            </div>
          )}
          {row.label_notes && (
            <div>
              <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3 }}>Golden notes</div>
              <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.5, fontStyle: "italic" }}>{row.label_notes}</div>
            </div>
          )}
          {row.reasoning && (
            <div>
              <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3 }}>Judge reasoning</div>
              <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.5, fontStyle: "italic" }}>{row.reasoning}</div>
            </div>
          )}
          {row.evidence_text && (
            <div>
              <div style={{ fontSize: 10, color: "var(--accent3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>
                🧾 Golden page evidence (pages {row.expected_pages.join(", ")})
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text2)", lineHeight: 1.55, whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", background: "var(--surface)", border: "1px solid var(--accent3)", borderRadius: 6, padding: "8px 10px" }}>
                {row.evidence_text}
              </div>
            </div>
          )}
          <div>
            <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>
              Retrieved chunks ({row.chunks.length} · reranker {row.reranker_used ? "on" : "off"})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {row.chunks.length === 0
                ? <div style={{ fontSize: 11, color: "var(--text3)" }}>No chunks retrieved — ingest the manual first.</div>
                : row.chunks.map((c, i) => <ChunkCard key={c.chunk_id} chunk={c} rank={i + 1} />)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GoldenEvalTab({ onLog }) {
  const [sections, setSections] = useState([]);
  const [section, setSection] = useState("");
  const [topK, setTopK] = useState(5);
  const [docId, setDocId] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/golden/sections`)
      .then(r => r.json())
      .then(j => {
        setSections(j.sections || []);
        if (j.sections?.length) setSection(j.sections[0].section);
        onLog("info", `Golden sections loaded: ${j.count}`);
      })
      .catch(e => onLog("err", `Could not load golden sections: ${e.message}`));
  }, []);

  async function run({ files: uploadedFiles } = {}) {
    setLoading(true);
    setData(null);
    const fileCount = uploadedFiles?.length ?? 0;
    onLog("info", fileCount > 0
      ? `Golden eval: uploading ${fileCount} file${fileCount > 1 ? "s" : ""} (${Array.from(uploadedFiles).map(f => f.name).join(", ")})`
      : `Golden eval: section ${section}`
    );
    try {
      const qs = new URLSearchParams({ top_k: String(topK) });
      if (!fileCount && section) qs.set("section", section);
      if (docId.trim()) qs.set("source_document_id", docId.trim());
      const opts = { method: "POST", signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 300000); return c.signal; })() };
      if (fileCount > 0) {
        const fd = new FormData();
        for (const f of uploadedFiles) fd.append("files", f);
        opts.body = fd;
      }
      const res = await fetch(`${API}/evaluate-golden?${qs.toString()}`, opts);
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || `HTTP ${res.status}`); }
      const json = await res.json();
      setData(json);
      const o = json.summary.overall;
      const pct = v => v != null ? Math.round(v * 100) + "%" : "—";
      const sectionsLabel = json.sections?.length > 1 ? json.sections.join(", ") : json.section;
      onLog("ok", `✓ Golden [${sectionsLabel}] ${o.count} cases · page-hit ${pct(o.page_hit_rate)} · acc ${pct(o.avg_answer_accuracy)} · ${o.pass_count} pass / ${o.fail_count} fail`);
    } catch (e) {
      onLog("err", `Golden eval failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  const o = data?.summary?.overall;
  const pct = v => v != null ? Math.round(v * 100) + "%" : "—";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 2fr", gap: 12 }}>
          <div className="form-group">
            <label className="form-label">Golden section</label>
            <select className="form-input" value={section} onChange={e => setSection(e.target.value)}>
              {sections.map(s => (
                <option key={s.section} value={s.section}>
                  {s.section} ({s.case_count} cases){s.has_user_queries ? "" : " — no stored queries"}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Top K</label>
            <input className="form-input" type="number" min={1} max={20} value={topK}
              onChange={e => setTopK(Number(e.target.value))} />
          </div>
          <div className="form-group">
            <label className="form-label">Doc ID (optional — scope retrieval)</label>
            <input className="form-input" value={docId} onChange={e => setDocId(e.target.value)}
              placeholder="Restrict to one ingested document" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button className="btn btn-primary" disabled={loading || !section} onClick={() => run()}>
            {loading ? "Evaluating…" : "▶ Run golden eval (stored queries)"}
          </button>
          <input ref={inputRef} type="file" accept=".json" multiple style={{ display: "none" }}
            onChange={e => { if (e.target.files?.length) run({ files: e.target.files }); e.target.value = ""; }} />
          <button className="btn btn-secondary" disabled={loading} onClick={() => inputRef.current?.click()}>
            ⬆ Upload JSON file(s)
          </button>
          {loading && <div className="spinner" />}
        </div>
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 8 }}>
          Maps each user query to its golden case by (section, case_id) → runs RAG → scores page-hit (objective) + answer accuracy (LLM vs golden).
          Upload multiple JSON files at once to evaluate several sections in a single run.
        </div>
      </div>

      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
            {[
              ["Section", data.section, "var(--accent2)"],
              ["Cases", o.count, "var(--accent)"],
              ["Page-hit rate", pct(o.page_hit_rate), "var(--accent3)"],
              ["Top-1 hit", pct(o.top1_hit_rate), "var(--accent3)"],
              ["Avg page recall", pct(o.avg_page_recall), "var(--accent)"],
              ["Avg accuracy", pct(o.avg_answer_accuracy), "var(--accent)"],
              ["Pass / Fail", `${o.pass_count} / ${o.fail_count}`, o.fail_count === 0 ? "var(--accent3)" : "var(--warn)"],
            ].map(([k, v, c]) => (
              <div key={k} style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: "var(--mono)", marginBottom: 4 }}>{k}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: c, fontWeight: 700 }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text3)" }}>
            Mapped <b style={{ color: "var(--accent3)" }}>{data.matched}</b> queries to golden cases
            {data.unmatched.length > 0 && <> · <span style={{ color: "var(--danger)" }}>unmatched: {data.unmatched.join(", ")}</span></>}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.rows.length === 0
              ? <div className="empty"><div className="empty-icon">📭</div><p>No cases evaluated.</p></div>
              : data.rows.map((r, i) => <GoldenRow key={r.case_id ?? i} row={r} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main VECTORA Panel ─────────────────────────────────────────────────────────

const TABS = [
  { id: "ingest",  label: "📥 Ingest",         badge: null },
  { id: "query",   label: "🔗 Query Pipeline",  badge: "AI" },
  { id: "batch",   label: "🧪 Batch Evaluate",  badge: "RAG" },
  { id: "golden",  label: "🥇 Golden Eval",     badge: "GOLD" },
  { id: "search",  label: "🔍 Vector Search",   badge: null },
  { id: "eval",    label: "📊 Eval Log",         badge: null },
];

export default function VectoraPanel({ showToast }) {
  const [tab, setTab] = useState("ingest");
  const [logs, setLogs] = useState([
    { level: "accent", msg: "VECTORA — Vector Embedding and Retrieval Evaluation Module · Ready" },
    { level: "info",   msg: "Ingest documents (PDF/DOCX/TXT), then query or search." },
  ]);
  const logRef = useRef(null);

  const addLog = useCallback((level, msg) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-300), { level, msg: `[${time}] ${msg}` }]);
    setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, 50);
  }, []);

  const logAndToast = useCallback((level, msg) => {
    addLog(level, msg);
    if (showToast) showToast(msg, level === "ok" ? "success" : level === "err" ? "error" : "info");
  }, [addLog, showToast]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Header banner */}
      <div style={{
        background: "linear-gradient(135deg, rgba(124,58,237,0.12), rgba(0,229,255,0.06))",
        border: "1px solid rgba(124,58,237,0.25)", borderRadius: 10, padding: "18px 22px",
        display: "flex", alignItems: "center", gap: 16,
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 10,
          background: "linear-gradient(135deg, rgba(124,58,237,0.3), rgba(0,229,255,0.15))",
          border: "1px solid rgba(124,58,237,0.4)", display: "flex", alignItems: "center",
          justifyContent: "center", fontSize: 20, flexShrink: 0,
        }}>⚡</div>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 16, color: "var(--text)" }}>VECTORA</span>
            <Badge text="pgvector" color="var(--accent2)" />
            <Badge text="LLM Reranker" color="var(--accent)" />
          </div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 3, fontFamily: "var(--mono)" }}>
            Vector Embedding &amp; Retrieval Evaluation · Embed → Retrieve → Rerank → Context
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, background: "var(--surface2)", borderRadius: 8, padding: 3 }}>
        {TABS.map(t => (
          <button key={t.id}
            style={{
              flex: 1, padding: "7px 10px", borderRadius: 6, border: "none", cursor: "pointer",
              background: tab === t.id ? "var(--surface)" : "transparent",
              color: tab === t.id ? "var(--text)" : "var(--text3)",
              fontWeight: 700, fontSize: 12, fontFamily: "var(--sans)",
              boxShadow: tab === t.id ? "0 1px 3px rgba(0,0,0,0.3)" : "none",
              transition: "all 0.15s", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge && <Badge text={t.badge} color="var(--accent3)" />}
          </button>
        ))}
      </div>

      {/* Active tab content */}
      <div>
        {tab === "ingest" && <IngestTab onLog={logAndToast} />}
        {tab === "query"  && <QueryTab  onLog={logAndToast} />}
        {tab === "batch"  && <BatchEvalTab onLog={logAndToast} />}
        {tab === "golden" && <GoldenEvalTab onLog={logAndToast} />}
        {tab === "search" && <SearchTab onLog={logAndToast} />}
        {tab === "eval"   && <EvalLogTab onLog={logAndToast} />}
      </div>

      {/* Activity log */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", borderBottom: "1px solid var(--border)",
        }}>
          <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text3)", letterSpacing: 1 }}>VECTORA LOG</span>
          <button className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px" }}
            onClick={() => setLogs([{ level: "info", msg: "Log cleared." }])}>Clear</button>
        </div>
        <div ref={logRef} className="terminal" style={{ height: 160, borderRadius: 0, border: "none" }}>
          {logs.map((l, i) => (
            <div key={i} className={`log-line log-${l.level}`}>{l.msg}</div>
          ))}
        </div>
      </div>

    </div>
  );
}
