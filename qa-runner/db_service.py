"""
db_service.py
─────────────────────────────────────────────────────────────────────────────
Async PostgreSQL service layer for CARA Automation Suite.
Uses asyncpg for high-throughput async queries.

Environment variables:
    CARA_DB_DSN  — full DSN, e.g. postgresql://cara_user:pass@localhost:5432/cara_db
                   If not set, falls back to the individual PG* vars below:
    PGHOST       — default: localhost
    PGPORT       — default: 5432
    PGDATABASE   — default: cara_db
    PGUSER       — default: cara_user
    PGPASSWORD   — (required if not using CARA_DB_DSN)

Usage (inside FastAPI):
    from db_service import db
    await db.connect()          # called once at startup
    await db.disconnect()       # called once at shutdown
    run = await db.save_test_run(...)
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import asyncpg

# ── Connection singleton ───────────────────────────────────────────────────────

class Database:
    _pool: Optional[asyncpg.Pool] = None

    def _dsn(self) -> str:
        # Priority: CARA_DB_DSN → DATABASE_URL (common convention) → individual PG* vars
        dsn = os.getenv("CARA_DB_DSN") or os.getenv("DATABASE_URL")
        if dsn:
            # asyncpg requires "postgresql://" not "postgres://" (common Heroku/Railway format)
            return dsn.replace("postgres://", "postgresql://", 1)
        host = os.getenv("PGHOST",     "localhost")
        port = os.getenv("PGPORT",     "5434")    # matches our docker-compose port
        db   = os.getenv("PGDATABASE", "cara_automation_db")
        user = os.getenv("PGUSER",     "cara_user")
        pwd  = os.getenv("PGPASSWORD", "cara_pass")
        return f"postgresql://{user}:{pwd}@{host}:{port}/{db}"

    async def connect(self) -> None:
        if self._pool is None:
            self._pool = await asyncpg.create_pool(
                self._dsn(),
                min_size=2,
                max_size=10,
                command_timeout=30,
            )
            print("[DB] Connected to PostgreSQL")

    async def disconnect(self) -> None:
        if self._pool:
            await self._pool.close()
            self._pool = None
            print("[DB] Disconnected from PostgreSQL")

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("Database not connected. Call await db.connect() first.")
        return self._pool

    # ── Test Runs ──────────────────────────────────────────────────────────────

    async def save_test_run(
        self, *,
        run_label:    Optional[str]  = None,
        project_name: str            = "CARA",
        backend_url:  Optional[str]  = None,
        brand:        Optional[str]  = None,
        total:        int            = 0,
        passed:       int            = 0,
        failed:       int            = 0,
        started_at:   Optional[datetime] = None,
        finished_at:  Optional[datetime] = None,
        duration_ms:  Optional[int]  = None,
        config:       Optional[Dict] = None,
    ) -> str:
        run_id = str(uuid.uuid4())
        pass_rate = round(passed / total * 100, 2) if total else 0
        await self.pool.execute(
            """
            INSERT INTO test_runs
              (id, run_label, project_name, backend_url, brand,
               total, passed, failed, pass_rate,
               started_at, finished_at, duration_ms, config)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            """,
            run_id, run_label, project_name, backend_url, brand,
            total, passed, failed, pass_rate,
            started_at or datetime.now(timezone.utc),
            finished_at,
            duration_ms,
            config,
        )
        return run_id

    async def save_test_results(self, run_id: str, results: List[Dict]) -> None:
        records = [
            (
                str(uuid.uuid4()),
                run_id,
                r.get("tc_id"),
                r.get("module"),
                r.get("flow"),
                r.get("input_text"),
                r.get("expected_intent"),
                r.get("actual_intent"),
                bool(r.get("pass", False)),
                r.get("confidence"),
                r.get("match_source"),
                r.get("expected_tool"),
                r.get("actual_tool"),
                r.get("tool_routing_ok"),
                r.get("routing_warning"),
                r.get("intent_chain"),
                r.get("response_message"),
                r.get("error_message"),
                r.get("latency_ms"),
            )
            for r in results
        ]
        await self.pool.executemany(
            """
            INSERT INTO test_results
              (id, run_id, tc_id, module, flow, input_text,
               expected_intent, actual_intent, pass, confidence, match_source,
               expected_tool, actual_tool, tool_routing_ok, routing_warning,
               intent_chain, response_message, error_message, latency_ms)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            """,
            records,
        )

    async def list_test_runs(self, limit: int = 50) -> List[Dict]:
        rows = await self.pool.fetch(
            "SELECT * FROM vw_run_summary LIMIT $1", limit
        )
        return [dict(r) for r in rows]

    async def get_test_run(self, run_id: str) -> Optional[Dict]:
        row = await self.pool.fetchrow(
            "SELECT * FROM test_runs WHERE id = $1", run_id
        )
        return dict(row) if row else None

    async def get_test_run_results(self, run_id: str) -> List[Dict]:
        rows = await self.pool.fetch(
            "SELECT * FROM test_results WHERE run_id = $1 ORDER BY created_at", run_id
        )
        return [dict(r) for r in rows]

    # ── PRISM Runs ─────────────────────────────────────────────────────────────

    async def save_prism_run(
        self, *,
        run_label:   Optional[str]   = None,
        project_name: str            = "CARA",
        backend_url: Optional[str]   = None,
        models:      Optional[List]  = None,
        languages:   Optional[List[str]] = None,
        query_count: int             = 0,
        started_at:  Optional[datetime] = None,
        finished_at: Optional[datetime] = None,
        duration_ms: Optional[int]   = None,
        config:      Optional[Dict]  = None,
    ) -> str:
        run_id = str(uuid.uuid4())
        await self.pool.execute(
            """
            INSERT INTO prism_runs
              (id, run_label, project_name, backend_url, models, languages,
               query_count, started_at, finished_at, duration_ms, config)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
            """,
            run_id, run_label, project_name, backend_url,
            _json(models or []),
            languages or [],
            query_count,
            started_at or datetime.now(timezone.utc),
            finished_at,
            duration_ms,
            _json(config or {}),
        )
        return run_id

    async def save_prism_results(self, prism_run_id: str, results: List[Dict]) -> None:
        records = [
            (
                str(uuid.uuid4()),
                prism_run_id,
                r.get("model_id"),
                r.get("model_name"),
                r.get("model_provider"),
                r.get("language_code"),
                r.get("query_id"),
                r.get("query_text"),
                r.get("expected_intent"),
                r.get("actual_intent"),
                bool(r.get("pass", False)),
                r.get("confidence"),
                r.get("match_source"),
                r.get("latency_ms"),
                r.get("input_tokens"),
                r.get("output_tokens"),
                r.get("cost_usd"),
                r.get("response_message"),
                r.get("error_message"),
            )
            for r in results
        ]
        await self.pool.executemany(
            """
            INSERT INTO prism_results
              (id, prism_run_id, model_id, model_name, model_provider,
               language_code, query_id, query_text,
               expected_intent, actual_intent, pass, confidence, match_source,
               latency_ms, input_tokens, output_tokens, cost_usd,
               response_message, error_message)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            """,
            records,
        )

    async def list_prism_runs(self, limit: int = 50) -> List[Dict]:
        rows = await self.pool.fetch(
            "SELECT * FROM vw_prism_summary LIMIT $1", limit
        )
        return [dict(r) for r in rows]

    async def get_prism_run(self, run_id: str) -> Optional[Dict]:
        row = await self.pool.fetchrow(
            "SELECT * FROM prism_runs WHERE id = $1", run_id
        )
        return dict(row) if row else None

    async def get_prism_run_results(self, run_id: str) -> List[Dict]:
        rows = await self.pool.fetch(
            "SELECT * FROM prism_results WHERE prism_run_id = $1 ORDER BY model_id, language_code, created_at",
            run_id,
        )
        return [dict(r) for r in rows]

    async def get_prism_model_lang_accuracy(self, run_id: str) -> List[Dict]:
        rows = await self.pool.fetch(
            "SELECT * FROM vw_prism_model_lang_accuracy WHERE prism_run_id = $1", run_id
        )
        return [dict(r) for r in rows]

    # ── Languages ──────────────────────────────────────────────────────────────

    async def get_languages(self) -> List[Dict]:
        rows = await self.pool.fetch(
            "SELECT * FROM languages WHERE enabled = TRUE ORDER BY sort_order"
        )
        return [dict(r) for r in rows]

    # ── Intent Map ─────────────────────────────────────────────────────────────

    async def upsert_intent_map(self, entries: List[Dict]) -> None:
        for e in entries:
            await self.pool.execute(
                """
                INSERT INTO intent_tool_map (intent, tool, handler, backend_types, description, updated_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (intent) DO UPDATE
                  SET tool          = EXCLUDED.tool,
                      handler       = EXCLUDED.handler,
                      backend_types = EXCLUDED.backend_types,
                      description   = EXCLUDED.description,
                      updated_at    = NOW()
                """,
                e.get("intent"), e.get("tool"), e.get("handler"),
                e.get("backend_types") or [],
                e.get("description"),
            )

    async def get_intent_map(self) -> List[Dict]:
        rows = await self.pool.fetch(
            "SELECT * FROM intent_tool_map ORDER BY intent"
        )
        return [dict(r) for r in rows]

    # ── Health check ───────────────────────────────────────────────────────────

    async def ping(self) -> bool:
        try:
            await self.pool.execute("SELECT 1")
            return True
        except Exception:
            return False


# ── Module-level singleton ────────────────────────────────────────────────────

db = Database()


# ── Utilities ─────────────────────────────────────────────────────────────────

import json as _json_lib

def _json(obj: Any) -> str:
    return _json_lib.dumps(obj, default=str)
