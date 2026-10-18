# Product and architecture decisions

## Product principles

- Keep the interface light, workspace-first, readable, and explicit about live versus demo state.
- The schema canvas, SQL editor, and data grid must reflect the connected database after successful introspection.
- A draft is not persisted state. Show generated SQL and require explicit review before supported schema changes.
- Keep PostgreSQL and MySQL differences behind the API's database services.
- Keep AI out of the critical path until the visual and synchronized database workflows are reliable.

## Current implementation

`apps/web` is a React, Vite, and TypeScript workspace. It uses React Flow for the schema canvas, AG Grid Community for records and query results, and Monaco for SQL. `apps/api` is an Express and TypeScript service with Zod validation, `pg` and `mysql2` adapters, schema introspection, bounded reads, reviewed DDL, and reviewed row insert, update, and delete operations. `packages/shared` holds shared contracts.

PostgreSQL and MySQL connections become in-memory API sessions with a 15-minute idle expiry. The API binds to loopback, validates and pins a resolved database host, blocks common metadata and link-local targets, and retains the hostname for TLS verification. These controls reduce local exposure but do not provide production authentication, tenant isolation, rate limiting, or complete hosted egress controls.

### Live schema and records

- Introspection returns visible base tables, columns, primary keys, foreign keys, generated-column metadata, and nullability where available.
- Record pages are bounded at 100 rows and 2 MB. Search matches case-insensitively across visible columns in the full table; sorting is performed by the database, and paging stays server-side.
- Row editing requires all primary-key columns and accepts scalar values only. It excludes primary-key and generated columns, uses bound values and optimistic concurrency checks, and reports a conflict if the original values no longer match.
- Row insertion accepts scalar values only, omits generated and identity columns, preserves database defaults, and checks required fields before issuing a one-use, session-bound plan. The UI shows the submitted values and requires explicit confirmation.
- Row deletion is available only for rows with a primary key and scalar values. The API previews the exact row, then uses primary-key and null-safe original-value checks so a stale row cannot be deleted by the confirmation. Plans are session-bound, expire after five minutes, and can execute once. Successful insert/delete refreshes the live record view.
- PostgreSQL 18.6 was exercised locally end to end with a disposable table: an insert received its generated identity and default value, and a reviewed deletion removed the unchanged row. The verification table was removed afterward.

### Supported schema changes

- **Create table:** a limited visual definition (up to 50 columns; integer, bigint, varchar, text, boolean, timestamp, decimal; optional primary key). The API validates the target, builds dialect-specific SQL, stores a one-use session-bound plan for five minutes, and executes only after explicit confirmation. MySQL DDL may commit implicitly.
- **Add column:** one constrained `ALTER TABLE … ADD COLUMN` with a supported type and optional nullability modifier. The API parses and normalizes this subset, verifies the target, issues a one-use session-bound preview, and runs only after confirmation.
- After successful DDL, the frontend re-introspects the database. If refresh fails or the new object is not visible, it keeps an explicit verification notice rather than claiming the canvas is synchronized.
- The PostgreSQL 18.6 local workflow has been exercised end to end: a reviewed table creation appeared in refreshed schema metadata, a reviewed add-column plan executed and appeared on re-introspection, and the temporary verification table was removed afterward.

### SQL execution and demo state

Live SQL accepts one `SELECT` or read-only CTE in a read-only transaction, with an eight-second timeout, 1,000-row limit, and 2 MB response limit. Data-changing SQL and general-purpose DDL are rejected. `ALTER TABLE … ADD COLUMN` is offered through its separate reviewed flow.

Demo records and SQL output are local sample data. Demo mode does not send editor text to the API and is read-only. Learning screens are explanatory shells; interactive lessons, analytics, query history, general filters, live result export, bulk data changes, and broad DDL are future work.

## Synchronization contract

1. Build a schema draft locally.
2. Validate the draft on the API and generate dialect-specific SQL.
3. Show the normalized SQL and require explicit confirmation.
4. Execute only the stored, one-use plan bound to the current session.
5. Re-introspect the connected database and update the canvas only from returned catalog metadata.
6. If execution or introspection fails, report the actual state and provide a way to verify it.

Manual query execution is read-only. Any future broader DDL support must detect supported schema changes, preserve explicit preview/confirmation for changes, and refresh from the database after success.

## Security and licensing guardrails

- Keep credentials in the local API's expiring memory sessions; never store them in frontend state beyond the form or log request bodies.
- Bind values as parameters and validate/quote identifiers separately.
- Enforce query, page, payload, and connection limits; validate TLS certificates when enabled.
- Do not expose anonymous arbitrary-host database connections in a hosted deployment. Add authentication, authorization, rate limits, audit records, and strict network egress controls first.
- Check dependency license, maintenance, compatibility, and commercial feature boundaries before adding dependencies. AG Grid Community is used for its available community feature set.

## Next slices

1. Add focused frontend workflow coverage for connection errors, DDL and row-change review, schema refresh failures, and record-edit conflicts.
2. Add repeatable database-backed integration coverage using an explicitly isolated test database, including MySQL insert/delete behavior.
3. Improve server-side filtering and build guided lessons and analytics only after the core live workflows remain reliable.
