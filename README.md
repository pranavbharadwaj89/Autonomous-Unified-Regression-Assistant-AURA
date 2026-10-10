# Autonomous Unified Regression Assistant (AURA)

QA tooling for the **cara_backend** voice assistant: text regression via `POST /api/v1/process-text`, and LiveKit voice E2E suites via the qa-runner service.

## Project layout

| Path | Role |
|------|------|
| `frontend/` | React dashboard (Vite) — text regression, single-prompt testing, reports |
| `qa-runner/` | FastAPI service — orchestrates cara_backend voice E2E test suites |
| `backend-feature-demo-develop/cara_backend/` | CARA backend (FastAPI on port **9090** + LiveKit agent worker) — **private, not included in this repository** |

> **Note:** The CARA backend lives in a separate private repository. To run the full stack, place it at `backend-feature-demo-develop/cara_backend` or point `CARA_BACKEND_PATH` at your own copy. The frontend and qa-runner in this repo are published on their own.

## Prerequisites

- Node.js 18+
- Python 3.12+
- Postgres + Redis for cara_backend (see `backend-feature-demo-develop/cara_local_infra/`)
- Poetry in `cara_backend` for Python dependencies

## First-time setup

### 1. cara_backend

```powershell
cd backend-feature-demo-develop\cara_backend
copy .env.example .env
# Edit .env — set POSTGRES_*, REDIS_*, LIVEKIT_*, API keys as needed

poetry install
cd ..\cara_local_infra
docker compose up -d
cd ..\cara_backend
.\scripts\run_postgres_migration.sh
```

### 2. Frontend

```powershell
cd frontend
npm install
copy .env.example .env
```

### 3. QA runner

```powershell
cd qa-runner
pip install -r requirements.txt
```

Optional: copy the suite-root env file:

```powershell
cd ..
copy .env.example .env
```

## Running locally

Start three services (three terminals):

**Terminal 1 — cara_backend API + agent**

```powershell
cd backend-feature-demo-develop\cara_backend
python -m src.main
# In another terminal for voice E2E:
python -m src.agent.main
```

Or use the bundled launcher: `./scripts/launch.sh` (Git Bash / WSL).

**Terminal 2 — QA runner (port 3001)**

```powershell
npm run dev:qa-runner
```

**Terminal 3 — React dashboard (port 5173)**

```powershell
npm run dev
```

Open http://localhost:5173

## Configuration

| Variable | Default | Used by |
|----------|---------|---------|
| `VITE_BACKEND_URL` | `http://127.0.0.1:9090` | Frontend → cara_backend text API |
| `VITE_QA_RUNNER_URL` | `http://127.0.0.1:3001` | Frontend → voice E2E orchestration |
| `CARA_BACKEND_PATH` | auto-detected | qa-runner → E2E scripts in cara_backend |
| `CARA_UAT_BASE_URL` | `http://127.0.0.1:9090` | qa-runner UAT environment preset |

`cara_backend` is auto-detected at `backend-feature-demo-develop/cara_backend`. Override with `CARA_BACKEND_PATH` if needed.

## API endpoints used

**cara_backend (port 9090)**

- `GET /health` — health check
- `POST /api/v1/process-text` — text regression (used by Run Tests / Single Voice Test)

**qa-runner (port 3001)**

- `GET /health` — includes resolved `cara_backend` path
- `GET /suites` — available voice E2E suites
- `POST /runs` — start voice E2E regression
- `GET /runs/{id}` — run status and results

See `qa-runner/README.md` for full qa-runner API details.
