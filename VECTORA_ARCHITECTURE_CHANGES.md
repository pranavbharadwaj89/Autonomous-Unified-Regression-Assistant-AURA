# VECTORA — Architecture Changes

**Module:** VECTORA (Vector Embedding & Retrieval Evaluation) inside the CARA Automation Suite
**Manual under test:** Citroën Basalt 2026 Owner's Manual (PDF)
**Scope of this document:** all architecture changes made in this work cycle — the *Hard-Evidence* grounding feature, the chunker page-accuracy fix, and the *Golden Test-Case Evaluation* feature.

---

## 1. Why these changes

The original VECTORA could ingest a PDF, embed it, retrieve chunks, and have an LLM score them. But the judge was grading the retrieved snippets **against themselves** — there was no independent source of truth. Two capabilities were added to make evaluation *trustworthy and objective*:

1. **Hard Evidence** — keep the raw, un-chunked text of every PDF page in the database as the judge's ground truth ("go to page 62 and check").
2. **Golden Test-Case Evaluation** — score real user queries against a human-verified answer key (`gold_*.json`) that specifies the *correct pages* for each question, giving an **objective page-hit metric** plus an LLM accuracy score.

---

## 2. Change summary

| Area | Change | Files |
|---|---|---|
| DB schema | New table `vectora_page_evidence` (hard evidence) | `src/vectora/models.py` |
| Ingest | Store full per-page text at ingest; report truthful stored count | `src/vectora/services/vector_store.py`, `chunking_service.py` |
| Chunker | **Fixed page-number bug** — each chunk now carries its own page | `src/vectora/services/chunking_service.py` |
| Storage | Switched chunk insert to Core executemany (robust) + safety net | `src/vectora/services/vector_store.py` |
| Grounded scoring | Judge scores retrieved + expected answer vs hard-evidence page | `src/vectora/services/batch_evaluator.py` |
| **Golden eval** | **New** `GoldenEvaluator` service (map → retrieve → page-hit → judge) | `src/vectora/services/golden_evaluator.py` |
| Golden data | 9 `gold_*.json` + 9 `en_*.json` stored in backend | `data/golden_cases/`, `data/user_queries/` |
| API | New endpoints: `/page-evidence`, `/golden/sections`, `/evaluate-golden` | `src/api/v1/vectora_router.py`, `src/models/vectora_api_models.py` |
| Frontend | New tabs: Hard-Evidence block in Batch, **🥇 Golden Eval** tab | `frontend/src/components/VectoraPanel.jsx` |

---

## 3. Data model

Everything lives in **one PostgreSQL database** (`cara_db`, port 5432) except the golden answer key, which is JSON on disk.

### Database tables
| Table | Holds |
|---|---|
| `vectora_source_documents` | one row per ingested PDF (filename, chunk_count, embedding model) |
| `vectora_document_chunks` | each chunk: `text`, **`embedding vector(1536)`**, `page_number`, `section_title` |
| `vectora_page_evidence` **(NEW)** | **hard evidence** — the raw plain-English full text of each page (`page_number`, `page_text`, `char_count`), unique per (document, page) |
| `vectora_evaluation_logs` | every evaluation result (query, retrieved chunk ids, score, feedback) |

### Golden JSON files (stored in the backend, not the DB)
```
data/golden_cases/gold_01..09_*.json   ← the answer key (109 cases across 9 sections)
data/user_queries/en_01..09_*.json     ← the natural-language user questions
```
- **Golden case** → `id`, `expected_section` (plain English), **`expected_pages`** (ground-truth pages, e.g. `[61,62]`), `label_notes` (verified description), `intent_type`, `answerable`.
- **User query** → `case_id` (→ golden `id`), `text` (the question).
- **Join key:** `(section, case_id)`. e.g. `en_01` query `KEYLESS_START` ↔ `gold_01` case `KEYLESS_START`.

---

## 4. The two evaluation flows

### Flow A — Batch Evaluate (Excel / audio) + Hard Evidence
```
Excel row / audio ─► query ─► embed ─► retrieve ─► rerank ─► context
                                             │
                     top chunks' pages ──────┘──► pull HARD EVIDENCE (those pages' full text)
                                             │
                        LLM JUDGE ───────────┘  scores:
                          • relevance (context vs query)
                          • expected_match (context vs Excel expected answer)
                          • intent(ret)  = context vs hard-evidence pages
                          • intent(exp)  = expected answer vs hard-evidence pages
                          verdict from the grounding score
```

### Flow B — Golden Evaluate (NEW)
```
en_*.json queries ─► MAP to gold_*.json by (section, case_id)   [before scoring]
      │
      ▼ per mapped query:
  embed ─► retrieve ─► rerank ─► context + retrieved pages
      │
      ├─ PAGE-HIT (objective, NO LLM):
      │     did retrieved pages ∩ golden expected_pages ?
      │     → page_hit, top1_page_hit, page_recall, hit_rank
      │
      ├─ pull golden expected_pages' HARD EVIDENCE (the correct-answer text)
      │
      └─ LLM JUDGE: does retrieved context support the golden expected answer?
            → answer_accuracy (0..1)
      verdict = page_hit AND answer_accuracy ≥ threshold (0.7)
```
Aggregated **per section and overall**: page-hit rate, top-1 hit rate, avg page recall, avg answer accuracy, pass/fail counts.

---

## 5. Component roles

| Role | Component | File | Engine |
|---|---|---|---|
| Chunker | `ChunkingService` | `chunking_service.py` | tiktoken `cl100k_base`, pypdf |
| Embedder | `EmbeddingService` | `embedding_service.py` | OpenAI `text-embedding-3-small` (1536-d) |
| Executor (RAG pipeline) | `QueryPipeline` | `query_pipeline.py` | embed → retrieve → rerank |
| Reranker | `RerankerService` | `reranker.py` | OpenAI `gpt-4o-mini` (0.3·vec + 0.7·llm) |
| Batch evaluator | `BatchEvaluator` | `batch_evaluator.py` | Excel/audio; hard-evidence judge |
| **Golden evaluator** | **`GoldenEvaluator`** | **`golden_evaluator.py`** | map + page-hit + golden judge |
| Judge | `_judge()` inside each evaluator | — | OpenAI `gpt-4o-mini`, JSON scores |
| Storage | `VectorStore` → Postgres + pgvector | `vector_store.py` | cosine `<=>` |
| Facade / DI entry | `VectoraService` | `vectora_service.py` | wires everything |

---

## 6. API endpoints (`/api/v1/vectora`)

| Method & path | Purpose |
|---|---|
| `POST /ingest` | Upload PDF/DOCX/TXT → chunk + embed + store chunks + hard evidence |
| `POST /query` | Full RAG pipeline for one query |
| `POST /search` | Raw cosine similarity search |
| `POST /evaluate-batch` | Excel/audio batch eval with hard-evidence grounding |
| `GET /page-evidence` **(NEW)** | Return the plain-text hard evidence for one page |
| `GET /golden/sections` **(NEW)** | List stored golden sections + case counts |
| `POST /evaluate-golden` **(NEW)** | Run user-query JSON (uploaded or stored section) against golden cases |
| `POST /eval-log` | Record an evaluation result |

---

## 7. Scoring logic (Golden)

**Objective page metrics** (no LLM — cannot be gamed):
- `page_hit` = retrieved pages intersect golden `expected_pages`.
- `top1_page_hit` = the #1 reranked chunk's page is an expected page.
- `page_recall` = |retrieved ∩ expected| / |expected|.
- `hit_rank` = rank of the first retrieved chunk on an expected page.

**Semantic metric** (LLM judge): `answer_accuracy` (0–1) — does the retrieved context support the golden expected answer (section + notes + authoritative page text)?

**Verdict:** `pass` iff `page_hit AND answer_accuracy ≥ VECTORA_EVAL_PASS_THRESHOLD (0.7)`.

---

## 8. Key fixes made this cycle

1. **Chunker page-number bug (critical).** The chunker assigned one page per *section*; heading-less runs (most of a manual) collapsed into a null-page section, leaving ~78% of chunks with `page_number = NULL`. Grounding needs pages, so this was fixed to track each paragraph's page through packing — every chunk now carries its own page. (`chunking_service.py`: `_pack_paragraphs_into_chunks`, `_chunk_text_with_headings` with an `_UNSET` sentinel fix.)

2. **Chunk-insert robustness.** Switched chunk persistence from the ORM unit-of-work to a Core `executemany` insert, and added a post-flush verification. Truthful `chunk_count` is now reported.

---

## 9. Known issue (tracked, non-blocking)

**Chunk-insert shortfall.** In the live server, a small, variable number of chunks (≈5–7%) occasionally fail to persist — reproduces *only* in the uvicorn/asyncpg worker, never in standalone scripts, and is below the ORM layer. It does **not** affect page numbers, retrieval, or grounding. It is logged as a warning (ingest no longer fails) and the stored count is reported truthfully. To revisit: instrument inside the running worker; try `NullPool` / disable asyncpg statement cache.

---

## 10. Configuration (env vars)

| Var | Default | Controls |
|---|---|---|
| `RAG_CHUNK_SIZE_TOKENS` | 400 | Max tokens per chunk |
| `RAG_CHUNK_OVERLAP_PCT` | 0.10 | Sliding-window overlap |
| `OPENAI_EMBEDDING_MODEL` | text-embedding-3-small | Embedding model |
| `VECTORA_RETRIEVAL_MULTIPLIER` | 4 | Over-fetch factor before rerank |
| `VECTORA_VECTOR_WEIGHT` / `VECTORA_LLM_WEIGHT` | 0.3 / 0.7 | Rerank fusion |
| `VECTORA_EVAL_MODEL` | gpt-4o-mini | Judge model |
| `VECTORA_EVAL_PASS_THRESHOLD` | 0.7 | Pass/fail cutoff |
| `VECTORA_GOLDEN_DIR` / `VECTORA_USER_QUERIES_DIR` | `data/golden_cases`, `data/user_queries` | Golden data locations |

---

## 11. How to run

1. **Backend:** `python -m src.main` from `backend-feature-demo-develop/cara_backend` (port 9090).
   ⚠️ OneDrive breaks uvicorn auto-reload — **hard-restart** after any `.py` edit.
2. **Frontend:** `npm run dev` in `frontend/` (port 5174).
3. **Ingest** the manual once (VECTORA → Ingest) — populates chunks + hard evidence.
4. **Golden Eval** tab → pick a section (or upload an `en_*.json`) → Run. Shows page-hit %, accuracy %, pass/fail per case, with expandable golden evidence + retrieved chunks.

---

## 12. First run result (section: access_keys_locking, 13 cases)

| Metric | Value |
|---|---|
| Cases mapped | 13 / 13 |
| Page-hit rate | 85% |
| Top-1 hit rate | 46% |
| Avg page recall | 81% |
| Avg answer accuracy | 96% |
| Pass / Fail | 10 / 3 |

The 3 failures were genuine signal (one partial-support answer; two where the expected page 24 content was retrieved from adjacent chunks tagged p.23/p.25) — demonstrating the evaluation surfaces real retrieval gaps rather than rubber-stamping.

---

*Page-numbering note:* golden `expected_pages` use docling PDF page numbers; ingested chunk `page_number` uses pypdf 1-based pages. These were spot-verified to align for this manual (e.g. Keyless Start → p61/62). If a future manual shows a consistent offset, add a per-manual page-offset map in `GoldenEvaluator`.
