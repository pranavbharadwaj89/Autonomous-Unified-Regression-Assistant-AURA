# PostgreSQL Setup — CARA Automation Suite

## 1. Install PostgreSQL on Windows

### Option A — Official Installer (Recommended)
1. Download from https://www.postgresql.org/download/windows/
2. Run the installer — choose version **16.x**
3. During setup:
   - Set a password for the `postgres` superuser (e.g. `postgres`)
   - Port: **5432** (default)
   - Locale: default
4. The installer also installs **pgAdmin 4** (GUI tool)

### Option B — Chocolatey (PowerShell as Administrator)
```powershell
choco install postgresql --version=16 -y
```

### Option C — winget (Windows Package Manager)
```powershell
winget install PostgreSQL.PostgreSQL.16
```

---

## 2. Create the Database and User

Open **pgAdmin 4** or run these commands in **psql** (SQL Shell):

```sql
-- Connect as postgres superuser first
CREATE USER cara_user WITH PASSWORD 'cara_password';
CREATE DATABASE cara_db OWNER cara_user;
GRANT ALL PRIVILEGES ON DATABASE cara_db TO cara_user;
```

Or run this as a single PowerShell script (requires psql in PATH):
```powershell
$env:PGPASSWORD = "postgres"
psql -U postgres -c "CREATE USER cara_user WITH PASSWORD 'cara_password';"
psql -U postgres -c "CREATE DATABASE cara_db OWNER cara_user;"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE cara_db TO cara_user;"
```

---

## 3. Apply the Schema

From this directory (`qa-runner/`):
```powershell
$env:PGPASSWORD = "cara_password"
psql -U cara_user -d cara_db -f schema.sql
```

This creates all tables, views, indexes, and seeds the language catalogue.

---

## 4. Configure the QA Runner

Add this to your **`qa-runner/.env`** file (create it if it doesn't exist):

```env
# PostgreSQL connection
CARA_DB_DSN=postgresql://cara_user:cara_password@localhost:5432/cara_db

# Or use individual vars:
# PGHOST=localhost
# PGPORT=5432
# PGDATABASE=cara_db
# PGUSER=cara_user
# PGPASSWORD=cara_password
```

---

## 5. Install Python dependencies

```powershell
pip install asyncpg
```

Or add to `requirements.txt`:
```
asyncpg>=0.29.0
```

Then:
```powershell
pip install -r requirements.txt
```

---

## 6. Verify the connection

Start the QA Runner and hit:
```
GET http://localhost:3001/db/health
```

Expected response:
```json
{ "status": "ok" }
```

---

## 7. Sync the Intent Map to the DB

After starting the QA Runner:
```
POST http://localhost:3001/db/intent-map/sync
```

This reads `agent_tool_intent_map.json` from the `qa-runner/` directory and
upserts all intent → tool → handler mappings into the `intent_tool_map` table.

---

## What Gets Stored

| Table | Contents |
|-------|----------|
| `test_runs` | One row per regression run (metadata + stats) |
| `test_results` | One row per test case execution (intent, confidence, tool routing) |
| `prism_runs` | One row per PRISM benchmark run |
| `prism_results` | One row per (model × language × query) result |
| `languages` | Language catalogue (18 languages, pre-seeded) |
| `intent_tool_map` | Intent → tool → handler mapping (synced from JSON) |

## Useful Views

```sql
-- Recent regression run summaries
SELECT * FROM vw_run_summary LIMIT 10;

-- Recent PRISM run summaries
SELECT * FROM vw_prism_summary LIMIT 10;

-- PRISM accuracy per model per language for a specific run
SELECT * FROM vw_prism_model_lang_accuracy
WHERE prism_run_id = '<your-run-id>';
```

---

## pgAdmin Quick Tour

1. Open pgAdmin 4 from the Start menu
2. Add a server: right-click "Servers" → Register → Server
   - Name: `CARA Local`
   - Host: `localhost`, Port: `5432`
   - Username: `cara_user`, Password: `cara_password`
3. Expand: Servers → CARA Local → Databases → cara_db → Schemas → public → Tables
