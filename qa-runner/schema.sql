-- =============================================================================
-- CARA Automation Suite — PostgreSQL Schema
-- =============================================================================
-- Run this once against an empty database:
--   psql -U cara_user -d cara_db -f schema.sql
-- =============================================================================

-- Enable uuid support (Postgres 13+ has it built-in via gen_random_uuid())
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. REGRESSION TEST RUNS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS test_runs (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_label     VARCHAR(255),                     -- e.g. "Citroën IVI v1.78 — Sprint 41"
    project_name  VARCHAR(255) NOT NULL DEFAULT 'CARA',
    backend_url   TEXT,
    brand         VARCHAR(100),
    total         INTEGER     NOT NULL DEFAULT 0,
    passed        INTEGER     NOT NULL DEFAULT 0,
    failed        INTEGER     NOT NULL DEFAULT 0,
    pass_rate     NUMERIC(5,2),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    duration_ms   INTEGER,
    config        JSONB,                            -- any extra key-value run config
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_test_runs_started ON test_runs (started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. INDIVIDUAL TEST RESULTS (per TC)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS test_results (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id            UUID        NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    tc_id             VARCHAR(100),                -- e.g. "TC_WEATH_011"
    module            VARCHAR(100),
    flow              VARCHAR(100),
    input_text        TEXT,
    expected_intent   VARCHAR(255),
    actual_intent     VARCHAR(255),
    pass              BOOLEAN     NOT NULL DEFAULT FALSE,
    confidence        INTEGER,                     -- 0-100
    match_source      VARCHAR(100),                -- "intent_exact" | "content_heuristic" | etc.
    expected_tool     VARCHAR(255),
    actual_tool       VARCHAR(255),
    tool_routing_ok   BOOLEAN,
    routing_warning   TEXT,
    intent_chain      TEXT,                        -- "intent → tool → handler" string
    response_message  TEXT,
    error_message     TEXT,
    latency_ms        INTEGER,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_test_results_run  ON test_results (run_id);
CREATE INDEX IF NOT EXISTS idx_test_results_pass ON test_results (run_id, pass);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PRISM BENCHMARK RUNS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS prism_runs (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_label     VARCHAR(255),
    project_name  VARCHAR(255) NOT NULL DEFAULT 'CARA',
    backend_url   TEXT,
    models        JSONB,                           -- [{id, name, provider, apiId, ...}]
    languages     TEXT[],                          -- ['en','hi','ta',...]
    query_count   INTEGER     NOT NULL DEFAULT 0,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    duration_ms   INTEGER,
    config        JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prism_runs_started ON prism_runs (started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. PRISM INDIVIDUAL RESULTS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS prism_results (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    prism_run_id     UUID        NOT NULL REFERENCES prism_runs(id) ON DELETE CASCADE,
    model_id         VARCHAR(100),
    model_name       VARCHAR(255),
    model_provider   VARCHAR(100),
    language_code    VARCHAR(20),
    query_id         VARCHAR(100),
    query_text       TEXT,
    expected_intent  VARCHAR(255),
    actual_intent    VARCHAR(255),
    pass             BOOLEAN     NOT NULL DEFAULT FALSE,
    confidence       INTEGER,
    match_source     VARCHAR(100),
    latency_ms       INTEGER,
    input_tokens     INTEGER,
    output_tokens    INTEGER,
    cost_usd         NUMERIC(14, 8),
    response_message TEXT,
    error_message    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prism_results_run    ON prism_results (prism_run_id);
CREATE INDEX IF NOT EXISTS idx_prism_results_model  ON prism_results (prism_run_id, model_id);
CREATE INDEX IF NOT EXISTS idx_prism_results_lang   ON prism_results (prism_run_id, language_code);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. LANGUAGES CATALOGUE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS languages (
    code        VARCHAR(20)  PRIMARY KEY,           -- BCP-47, e.g. "hi", "ta", "zh"
    label       VARCHAR(100) NOT NULL,
    group_name  VARCHAR(50),                        -- "Indian" | "International"
    script      VARCHAR(100),
    native_name VARCHAR(100),
    enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
    sort_order  INTEGER      DEFAULT 0
);

-- Seed the languages table (idempotent)
INSERT INTO languages (code, label, group_name, script, native_name, sort_order) VALUES
  ('hi', 'Hindi',      'Indian',        'Devanagari', 'हिन्दी',       1),
  ('ta', 'Tamil',      'Indian',        'Tamil',      'தமிழ்',        2),
  ('te', 'Telugu',     'Indian',        'Telugu',     'తెలుగు',       3),
  ('kn', 'Kannada',    'Indian',        'Kannada',    'ಕನ್ನಡ',        4),
  ('ml', 'Malayalam',  'Indian',        'Malayalam',  'മലയാളം',       5),
  ('bn', 'Bengali',    'Indian',        'Bengali',    'বাংলা',         6),
  ('mr', 'Marathi',    'Indian',        'Devanagari', 'मराठी',         7),
  ('gu', 'Gujarati',   'Indian',        'Gujarati',   'ગુજરાતી',       8),
  ('pa', 'Punjabi',    'Indian',        'Gurmukhi',   'ਪੰਜਾਬੀ',        9),
  ('or', 'Odia',       'Indian',        'Odia',       'ଓଡ଼ିଆ',         10),
  ('as', 'Assamese',   'Indian',        'Bengali',    'অসমীয়া',       11),
  ('ur', 'Urdu',       'Indian',        'Nastaliq',   'اردو',          12),
  ('en', 'English',    'International', 'Latin',      'English',       13),
  ('fr', 'French',     'International', 'Latin',      'Français',      14),
  ('ja', 'Japanese',   'International', 'Japanese',   '日本語',         15),
  ('es', 'Spanish',    'International', 'Latin',      'Español',       16),
  ('zh', 'Mandarin',   'International', 'Hanzi',      '普通话',         17),
  ('ko', 'Korean',     'International', 'Hangul',     '한국어',         18),
  ('pt', 'Portuguese', 'International', 'Latin',      'Português',     19)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label,
      group_name  = EXCLUDED.group_name,
      script      = EXCLUDED.script,
      native_name = EXCLUDED.native_name,
      sort_order  = EXCLUDED.sort_order;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. INTENT / TOOL CATALOGUE (cached from agent_tool_intent_map.json)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intent_tool_map (
    intent        VARCHAR(255) PRIMARY KEY,
    tool          VARCHAR(255),
    handler       VARCHAR(255),
    backend_types TEXT[],
    description   TEXT,
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. HELPER VIEWS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW vw_run_summary AS
SELECT
    r.id,
    r.run_label,
    r.project_name,
    r.brand,
    r.started_at,
    r.finished_at,
    r.total,
    r.passed,
    r.failed,
    ROUND(r.passed::NUMERIC / NULLIF(r.total, 0) * 100, 1) AS pass_rate_pct,
    r.duration_ms
FROM test_runs r
ORDER BY r.started_at DESC;

CREATE OR REPLACE VIEW vw_prism_summary AS
SELECT
    p.id,
    p.run_label,
    p.project_name,
    p.started_at,
    p.finished_at,
    p.query_count,
    array_length(p.languages, 1) AS lang_count,
    jsonb_array_length(p.models) AS model_count,
    p.duration_ms
FROM prism_runs p
ORDER BY p.started_at DESC;

-- PRISM accuracy per (run, model, language)
CREATE OR REPLACE VIEW vw_prism_model_lang_accuracy AS
SELECT
    pr.prism_run_id,
    pr.model_id,
    pr.model_name,
    pr.language_code,
    COUNT(*)                                                   AS total,
    SUM(CASE WHEN pr.pass THEN 1 ELSE 0 END)                  AS passed,
    ROUND(SUM(CASE WHEN pr.pass THEN 1 ELSE 0 END)::NUMERIC
          / NULLIF(COUNT(*), 0) * 100, 1)                     AS accuracy_pct,
    ROUND(AVG(pr.latency_ms))                                  AS avg_latency_ms,
    SUM(pr.cost_usd)                                           AS total_cost_usd
FROM prism_results pr
GROUP BY pr.prism_run_id, pr.model_id, pr.model_name, pr.language_code;
