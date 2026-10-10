# CARA QA Runner API

FastAPI service that runs CARA voice E2E regression suites and serves results to the React dashboard.

## Prerequisites

- Python 3.12+
- CARA backend at `backend-feature-demo-develop/cara_backend` (auto-detected in this repo)
- CARA API + agent running (for local tests) with LiveKit credentials in `cara_backend/.env`

## Setup

```powershell
cd qa-runner
pip install -r requirements.txt
```

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CARA_BACKEND_PATH` | auto-detected | Path to `cara_backend` folder |
| `CARA_UAT_BASE_URL` | `http://127.0.0.1:9090` | UAT API URL shown in dashboard |
| `QA_RUN_TIMEOUT_SEC` | `3600` | Per-suite timeout in seconds |

## Start API (port 3001)

```powershell
cd qa-runner
python main.py
```

## Start React dashboard (port 5173)

In a separate terminal from the suite root:

```powershell
npm run dev
```

Open http://localhost:5173 — use the **Voice E2E** tab to trigger suites from the UI.

## Smoke suites (default)

- `handle_session`
- `handle_weather`
- `handle_assistant_info`

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/suites` | List available test suites |
| GET | `/environments` | Local / UAT presets |
| POST | `/runs` | Start regression run |
| GET | `/runs/{id}` | Run status |
| GET | `/runs/{id}/results` | JSON results |
| GET | `/runs/{id}/report` | HTML report |
| GET | `/runs` | Recent runs |
