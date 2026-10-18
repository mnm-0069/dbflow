# DBFLOW

**A visual workspace for exploring database schemas, relationships, and records.**

DBFLOW is a local-first development project for PostgreSQL and MySQL. It includes a React workspace and a local API for schema inspection and guarded database operations.

## Current implementation

- Connect to PostgreSQL or MySQL through a local API session. Credentials stay in API memory for up to 15 minutes of inactivity and are cleared from the form when it closes.
- Inspect visible base tables, column types, primary keys, and foreign-key relationships in the schema canvas.
- Browse live table records in pages of up to 100 rows, sort across the full table, search the loaded page, and edit non-key scalar values on tables with a primary key.
- Create a table through a visual draft, review the generated engine-specific SQL, and explicitly confirm execution.
- Review one constrained `ALTER TABLE … ADD COLUMN` operation from the SQL editor before execution.
- Run a single read-only `SELECT` or read-only CTE in a read-only transaction. Results are capped at 1,000 rows and 2 MB.
- Explore clearly labeled sample records and sample SQL results without sending the editor text to a database.

Schema operations use a five-minute, one-use preview plan bound to the active database session. Successful operations trigger schema introspection. Row edits require the complete primary key, exclude primary-key and generated columns, use parameterized values, and compare the previous values to detect stale edits.

## Not implemented yet

- Arbitrary SQL execution, general-purpose DDL, destructive data changes, row insertion/deletion, and editing columns without a primary key.
- Search across all rows; search currently applies only to the loaded page.
- Query history, a functional filter builder or column chooser, live result export, guided lessons, and analytics dashboards.
- Persistent connection profiles, hosted accounts, and production authentication or audit controls.

The local API binds to `127.0.0.1` and rejects common cloud metadata and link-local targets. This is a local development foundation, not a production-secure arbitrary-host database service.

## Requirements and setup

- Node.js 20.19 or newer (the current environment uses Node 24).
- npm 10 or newer.
- PostgreSQL or MySQL for live database features; demo mode works without either.

```bash
npm install
npm run dev
```

The API uses port `4000` and the web app uses port `5173` by default. Copy `apps/api/.env.example` to `apps/api/.env` only if you need to change the local API settings; the default configuration works without it.

- Web: <http://localhost:5173>
- API health: <http://localhost:4000/api/health>

Never commit `.env` files or database credentials. `.env.example` contains only local development defaults.

## Project structure

```text
apps/web         React + Vite + TypeScript workspace
apps/api         Express API, database adapters, schema and record services
packages/shared  Shared contracts
docs             Setup and architecture notes
```

## Checks

```bash
npm run typecheck
npm run test --workspace @idp/api
npm run build
```

GitHub Actions runs these checks on pushes to `main` and on pull requests.

See [Getting started](docs/GETTING_STARTED.md) for connection and workflow details and [Product and architecture](docs/PRODUCT_AND_ARCHITECTURE.md) for current design boundaries.
