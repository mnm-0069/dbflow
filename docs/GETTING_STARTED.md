# Getting started

## Start the workspace

1. Install Node.js 20.19 or newer and npm 10 or newer.
2. Open a terminal in the project root.
3. Run `npm install`.
4. Optionally copy `apps/api/.env.example` to `apps/api/.env` to change the API port or allowed frontend origin.
5. Run `npm run dev`.
6. Open <http://localhost:5173>. The API health endpoint is <http://localhost:4000/api/health>.

Demo mode works without a database. Demo rows and sample SQL results are clearly labeled; **Preview demo rows** does not send the editor text anywhere.

## Start the sample PostgreSQL database

The repository includes a disposable PostgreSQL database with sample customers, products, orders, and order items. It is intended for local development and needs Docker Desktop or Docker Engine with the Compose plugin.

1. In the project root, start the database:

   ```bash
   npm run db:up
   ```

2. Wait until `docker compose ps` reports the `postgres` service as healthy.
3. In a second terminal, start DBFLOW with `npm run dev` and open <http://localhost:5173>.
4. Choose **Add connection** and enter these local sample credentials:

   | Field | Value |
   | --- | --- |
   | Engine | PostgreSQL |
   | Host | `127.0.0.1` |
   | Port | `5433` |
   | Database | `dbflow_demo` |
   | Username | `dbflow` |
   | Password | `dbflow_local_only` |
   | SSL | Off |

5. Choose **Test connection**, then **Inspect PostgreSQL schema**. The schema canvas should show `customers`, `products`, `orders`, and `order_items`, with their key relationships.
6. Open the SQL workspace and run this read-only query to see orders with customer names:

   ```sql
   SELECT c.full_name, o.status, o.total, o.created_at
   FROM orders AS o
   JOIN customers AS c ON c.id = o.customer_id
   ORDER BY o.created_at DESC;
   ```

The sample database port can be changed with `DBFLOW_POSTGRES_PORT=5434 npm run db:up`; enter the same port in the connection form. `npm run db:stop` stops the container while preserving its data. To remove the sample database and its stored volume, run `docker compose down --volumes` from the project root; this deletes all data in that local sample database.

The sample password is for this loopback-only development setup. Do not reuse it for a real database or expose the container to a network.

## Connect a live database

1. Start a PostgreSQL or MySQL database that is reachable from this machine.
2. Choose **Add connection**, enter the database details, and choose **Test connection**.
3. Choose **Inspect PostgreSQL schema** or **Inspect MySQL schema** to load the tables visible to that database user.
4. Select a table and choose **View live records**.

The connection form sends credentials to the local API. The API holds them only in an in-memory session, expires it after 15 idle minutes, and closes it when you disconnect. Connection profiles are not saved. Use a least-privilege database account. The local service is not production-hardened and should not be exposed as an unauthenticated database proxy.

## Work with live data and schema

- Schema introspection reads visible base tables, columns, types, primary keys, and foreign keys for PostgreSQL and MySQL.
- The data explorer pages through at most 100 rows at a time. Column sorting applies across the full table; search applies to the currently loaded page. **Edit selected row** is available only when the table has a primary key. The editor excludes primary-key and generated columns, accepts scalar values and `NULL` where allowed, and detects stale rows before saving.
- **New table** creates a draft using the supported types (integer, bigint, varchar, text, boolean, timestamp, and decimal). The API validates names and constraints, generates SQL, and returns a session-bound one-use preview that expires after five minutes. Execution requires checking the review confirmation. The schema is then re-introspected; if the new table is not visible or refresh fails, the UI reports that separately.
- In the SQL workspace, live queries allow one read-only `SELECT` or read-only CTE. The API runs it in a read-only transaction, caps results at 1,000 rows / 2 MB, and applies an eight-second query timeout.
- **Review schema change** accepts one constrained `ALTER TABLE … ADD COLUMN` statement with a supported type and optional `NULL` / `NOT NULL` modifier. The API normalizes identifiers and SQL, checks that the target and column are appropriate, and requires the same review and confirmation flow. The schema is refreshed after execution.

Other DDL, arbitrary SQL, destructive DML, row insertion/deletion, general-purpose filtering, and live export are not supported yet. MySQL DDL may commit implicitly according to MySQL behavior.

## Checks

Run these from the project root:

```bash
npm run typecheck
npm run test --workspace @idp/api
npm run build
```
