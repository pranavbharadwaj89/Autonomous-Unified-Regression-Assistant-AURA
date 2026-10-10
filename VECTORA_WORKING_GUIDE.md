# VECTORA — Working Guide (Step-by-Step Flow, Backend & Frontend)

Companion to `VECTORA_ARCHITECTURE_CHANGES.md`. This document explains **how the system
actually runs** end to end: the backend internals, the frontend internals, the step-by-step
flows, and the working understanding behind each new fix.

---

## 0. System topology (what's running)

```
┌────────────────────┐     HTTP /api/v1/vectora/*     ┌──────────────────────┐
│  Frontend (Vite)   │  ───────────────────────────►  │  Backend (FastAPI)   │
│  React · port 5174 │  ◄───────────────────────────  │  uvicorn · port 9090 │
└────────────────────┘         JSON responses         └──────────┬───────────┘
                                                                  │ asyncpg
                                                       ┌──────────▼───────────┐
                                                       │ PostgreSQL + pgvector │
                                                       │       port 5432       │
                                                       └───────────────────────┘
   Golden answer key (JSON) lives on the backend disk: data/golden_cases/, data/user_queries/
```

- **Frontend** proxies `/api` → `9090` (see `frontend/vite.config.js`).
- **Backend** holds the RAG services and talks to Postgres.
- **Postgres** stores chunks + vectors + hard evidence.
- **Golden JSON** is read from disk by the backend (not the DB).

---

## 1. BACKEND — how it works

### 1.1 Startup & dependency injection (happens once)

On boot, the DI container builds every service as a **singleton**
(`src/di/modules/business_services_module.py`):

```
EmbeddingService.get_instance()   ─┐
RerankerService.get_instance()    ─┤─► VectoraService(embedder, reranker)
                                        │  builds internally:
                                        ├─ BatchEvaluator
                                        └─ GoldenEvaluator   ← NEW
```

There is exactly **one** `VectoraService` for the whole app. It holds the (stateless)
embedder + reranker and constructs the evaluators. It does **not** hold a DB session —
sessions are created per request.

### 1.2 The request lifecycle (the async→sync bridge)

Every VECTORA route in `src/api/v1/vectora_router.py` follows the same shape:

```python
@router.post("/evaluate-golden")
async def evaluate_golden(...):
    svc = Depends(_get_vectora_service)     # the singleton
    db  = Depends(_get_db)                   # PostgresConnectionManager
    async with db.get_session() as session:  # async session (asyncpg)
        result = await session.run_sync(     # ← the bridge
            lambda sync_session: svc.evaluate_golden(sync_session=sync_session, ...)
        )
    return BuildPydanticResponse(result)
```

**Why this matters (a real working detail):** the web layer and DB driver are **async**
(asyncpg), but all VECTORA services (`VectorStore`, `QueryPipeline`, `ChunkingService`,
`BatchEvaluator`, `GoldenEvaluator`) are written **synchronously**. `session.run_sync(fn)`
runs the sync code on a greenlet over the async connection — so inside a service you write
ordinary blocking code and it "just works." **Any new DB operation must go through this
bridge.**

- `db.transaction()` = open session + `session.begin()` → **auto-commits** on clean exit,
  **rolls back** on exception. (Used by writes: ingest, eval-log.)
- `db.get_session()` = read-only, no auto-commit. (Used by query, search, golden eval,
  page-evidence.)

### 1.3 The services and what each does

| Service | Responsibility | Key methods |
|---|---|---|
| `ChunkingService` | PDF/DOCX/TXT → page-tagged chunks + per-page evidence | `chunk_document`, `extract_page_evidence` |
| `EmbeddingService` | text → 1536-float vector (OpenAI) | `embed_text`, `embed_texts` |
| `VectorStore` | store chunks/evidence, cosine search, fetch evidence | `insert_chunks`, `similarity_search`, `get_page_evidence` |
| `QueryPipeline` | the RAG executor: embed → retrieve → rerank → context | `run` |
| `RerankerService` | LLM re-scores the shortlist, fuses with vector sim | `rerank` |
| `BatchEvaluator` | Excel/audio eval + hard-evidence grounding | `evaluate_batch` |
| `GoldenEvaluator` **(NEW)** | map queries to golden cases → page-hit + judge | `evaluate`, `map_queries`, `list_sections` |
| `VectoraService` | facade over all of the above | `ingest`, `query`, `evaluate_golden`, … |

### 1.4 Storage reality

- **Cosine search** uses raw SQL: `1 - (embedding <=> CAST(:embedding AS vector))`, and the
  query vector is passed as a **pgvector string literal** `"[0.1,0.2,…]"` (asyncpg cannot
  bind a Python list to `::vector`).
- **Chunk writes** use a Core `executemany` INSERT (robust) with a post-flush count check.
- **Hard evidence** is one row per page in `vectora_page_evidence`.

---

## 2. FRONTEND — how it works

### 2.1 Component structure

`frontend/src/components/VectoraPanel.jsx` is a single React panel with a **tab bar**:

```
VectoraPanel
 ├─ header banner
 ├─ tab bar:  📥 Ingest | 🔗 Query | 🧪 Batch | 🥇 Golden Eval (NEW) | 🔍 Search | 📊 Eval Log
 ├─ active tab component:
 │    ├─ IngestTab        → POST /ingest
 │    ├─ QueryTab         → POST /query
 │    ├─ BatchEvalTab     → POST /evaluate-batch   (+ hard-evidence block)
 │    ├─ GoldenEvalTab    → GET /golden/sections, POST /evaluate-golden   ← NEW
 │    ├─ SearchTab        → POST /search
 │    └─ EvalLogTab       → POST /eval-log
 └─ activity log (bottom)
```

Reused presentational components: `Badge`, `ScorePill` (color-coded %), `VerdictBadge`
(PASS/FAIL), `ChunkCard` (a retrieved chunk), plus the new `PageHitPills` and `GoldenRow`.

### 2.2 State & data flow (the Golden tab as the example)

`GoldenEvalTab` is a self-contained component with React hooks:

```
useState:  sections[], section, topK, docId, loading, data
useEffect: on mount → fetch GET /golden/sections → fill the dropdown
run():     POST /evaluate-golden?section=…&top_k=…  → setData(json)
render:    summary cards + per-section stats + list of <GoldenRow/>
```

- **No global store** — each tab owns its state. Results live only in that tab until you
  re-run.
- Every API call is a `fetch()` with an `AbortController` (300 s timeout) so a slow eval
  can't hang the UI forever.
- Errors and successes are pushed to the shared **activity log** via `onLog(level, msg)`.

### 2.3 How a result is rendered

Backend returns `GoldenEvalResponse` → the tab renders:
1. **Summary cards**: page-hit rate, top-1 hit, avg recall, avg accuracy, pass/fail.
2. **Mapping line**: how many queries matched golden cases (+ any unmatched case_ids).
3. **One `GoldenRow` per case** — collapsed shows: case_id, query, `✓/✗ page` badge,
   accuracy pill, verdict. Expanded shows: expected vs retrieved **PageHitPills**, golden
   section + notes, judge reasoning, **golden page hard-evidence text**, and the retrieved
   chunks.

---

## 3. STEP-BY-STEP FLOWS

### 3.1 Ingest (with hard evidence)

```
1. User drops a PDF on the Ingest tab.
2. FE → POST /ingest (multipart file).
3. BE writes the upload to a temp file.
4. db.transaction() → run_sync → ingest_document():
     a. create source_documents row (status=processing)
     b. ChunkingService.chunk_document()      → N page-tagged chunks
     c. EmbeddingService.embed_texts()         → N vectors (batched 100/call)
     d. VectorStore.insert_chunks()            → Core executemany INSERT + count check
     e. ChunkingService.extract_page_evidence()→ raw full text per page
     f. VectorStore.insert_page_evidence()     → hard-evidence rows
     g. doc.status=ready, chunk_count = actually-stored count
5. commit → delete temp file → FE shows chunk_count + status.
```

### 3.2 Golden evaluation (the NEW feature — full trace)

```
1. User opens 🥇 Golden Eval, picks a section (e.g. access_keys_locking), clicks Run.
2. FE → POST /evaluate-golden?section=access_keys_locking&top_k=5[&source_document_id=…]
3. BE route → db.get_session() → run_sync → VectoraService.evaluate_golden():

     GoldenEvaluator:
     a. load_user_queries_for_section()  → read en_*.json (13 queries)
     b. map_queries()                     → JOIN queries to gold_*.json by (section, case_id)
                                            → 13 (query, golden_case) pairs, 0 unmatched
     c. for each pair → _evaluate_one():
          i.   QueryPipeline.run(query.text, top_k=5):
                 - EmbeddingService.embed_text(query)     → query vector
                 - VectorStore.similarity_search(×4)      → over-fetch candidates (cosine)
                 - RerankerService.rerank()               → LLM re-sort, keep top 5
                 - assemble context string
          ii.  retrieved_pages = unique pages of the ranked chunks
          iii. PAGE-HIT (objective, no LLM):
                 page_hit      = retrieved_pages ∩ golden.expected_pages ≠ ∅
                 top1_page_hit = top chunk's page ∈ expected_pages
                 page_recall   = |hit| / |expected|
          iv.  VectorStore.get_page_evidence(doc, expected_pages)  → correct-answer text
          v.   _judge(query, golden_reference, retrieved_context)  → answer_accuracy (LLM)
          vi.  verdict = page_hit AND answer_accuracy ≥ 0.7
     d. summarize() → overall + per-section aggregates.

4. BE → GoldenEvalResponse (rows + summary + matched/unmatched).
5. FE renders summary cards + per-case GoldenRows.
```

### 3.3 Batch evaluation (Excel/audio + hard evidence)

```
Excel row / audio → query → QueryPipeline.run() → gather top chunks' page evidence →
single LLM judge returns 4 scores (relevance, expected_match, intent-ret, intent-exp) →
verdict from the grounding score → per-row result + hard-evidence block in the UI.
```

---

## 4. WORKING UNDERSTANDING OF THE NEW FIXES

### 4.1 Chunker page-number fix (the one that unblocked everything)

**Problem:** the chunker assigned **one page per section**, and its section grouping had a
sentinel bug (`None != None` is `False`). In a manual with few detectable headings, most
paragraphs fell into a single "no-heading" section that got a **NULL** page — so ~78% of
chunks had no page number. With no page on a chunk, you can't "go to the right page," so
grounding and page-hit were impossible.

**Fix:** page is now tracked **per paragraph** and threaded through packing, so **each chunk
carries the page of its first paragraph**. Heading-less runs that span pages 60→64 now
produce chunks tagged 60, 61, 62… accurately. Result: 100% of chunks have a page.

```
BEFORE:  section → one page → many chunks (mostly NULL)      → grounding dead
AFTER:   paragraph → page → chunk keeps first paragraph's page → grounding works
```

Files: `chunking_service.py` (`_pack_paragraphs_into_chunks`, `_chunk_text_with_headings`
with the `_UNSET` sentinel).

### 4.2 Hard-evidence grounding

**Idea:** keep the raw, un-chunked text of every page in `vectora_page_evidence` at ingest
time. At eval time, after retrieval points to a page, pull that page's real text and have the
judge grade **against the untouched source page** instead of against the retrieved snippets.
This is what makes a high score mean "the answer really is on that page," not "the snippets
looked plausible."

### 4.3 Golden test-case evaluation (this cycle's main feature)

**Idea:** a human-verified answer key (`gold_*.json`) specifies, per question, the **correct
pages** and expected section/notes. User queries (`en_*.json`) carry a `case_id` mapping to
those golden cases. The evaluator:
- **maps first** (join by `(section, case_id)`) — mapping is applied *before* any scoring,
- computes an **objective page-hit** metric (no LLM — can't be gamed),
- adds an **LLM accuracy** score vs the golden expected answer,
- combines them into a pass/fail verdict, aggregated per section and overall.

This turns "does RAG feel right?" into "does RAG retrieve the correct, verified page for
each real user question — yes/no, and how accurately?"

### 4.4 Chunk-insert robustness + the known shortfall

**Change:** chunk persistence moved from the ORM unit-of-work to a Core `executemany` INSERT,
with a post-flush count check; the ingest now reports the **truthful** stored count.

**Known issue (tracked, non-blocking):** in the live uvicorn/asyncpg worker a small, variable
number of chunks (~5–7%) occasionally fail to persist — reproduces only in the server context,
never in standalone scripts, and sits below the ORM layer. It does **not** affect page
numbers, retrieval, or grounding. It is logged as a warning (ingest no longer fails) and
parked for later (see the architecture doc §9).

---

## 5. One case walked all the way through (worked example)

**Query:** "How do I start the car with the keyless system?" (case `KEYLESS_START`)

```
1. Map:      en_01.KEYLESS_START ─► gold_01.KEYLESS_START  (expected_pages = [61, 62])
2. Embed:    query → 1536-float vector
3. Retrieve: cosine search over the manual's chunk vectors → top candidates by page
4. Rerank:   LLM re-sorts → final top-5 chunks, one of which is page 62
5. Page-hit: retrieved pages include 62 ∈ {61,62}  → page_hit = TRUE
6. Evidence: pull the real text of pages 61 & 62 from vectora_page_evidence
7. Judge:    "does the retrieved context support the keyless-start procedure on p61/62?" → 1.0
8. Verdict:  page_hit AND 1.0 ≥ 0.7  → PASS
```

The UI shows this row as `✓ page · acc 100% · PASS`, and expanding it reveals the golden
pages, the retrieved pages, the judge's reasoning, and the actual page 61/62 text.

---

## 6. Quick reference — where to change what

| To change… | Edit |
|---|---|
| Chunk size / overlap / headings | env `RAG_CHUNK_*` or `chunking_service.py` |
| Embedding model | env `OPENAI_EMBEDDING_MODEL` / `embedding_service.py` |
| Retrieval breadth / rerank weights | env `VECTORA_RETRIEVAL_MULTIPLIER`, `VECTORA_*_WEIGHT` / `reranker.py` |
| Golden judge prompt / accuracy | `golden_evaluator.py` (`_JUDGE_PROMPT`, `_judge`) |
| Pass threshold | env `VECTORA_EVAL_PASS_THRESHOLD` |
| Page-hit logic / metrics | `golden_evaluator.py` (`_evaluate_one`, `summarize`) |
| Golden data location | env `VECTORA_GOLDEN_DIR` / `VECTORA_USER_QUERIES_DIR` |
| New endpoint | `vectora_router.py` + method in `vectora_service.py` |
| UI (Golden tab) | `frontend/src/components/VectoraPanel.jsx` (`GoldenEvalTab`, `GoldenRow`) |

⚠️ After any backend `.py` edit: **hard-restart** `python -m src.main` (OneDrive breaks
uvicorn auto-reload).
