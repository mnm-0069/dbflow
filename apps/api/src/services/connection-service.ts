import { randomBytes } from 'node:crypto';
import { Client as PgClient, Pool } from 'pg';
import mysql from 'mysql2/promise';
import { connect as netConnect } from 'node:net';
import { resolveDatabaseHost } from './database-host.js';

export type ConnectionInput = {
  engine: 'postgres' | 'mysql'; host: string; port: number; database: string;
  username: string; password: string; ssl: boolean;
};

export type PostgresSchemaTable = {
  schema: string;
  name: string;
  columns: Array<{ name: string; type: string; key?: 'pk' | 'fk' | 'pk-fk'; generated?: boolean; identity?: boolean; hasDefault?: boolean; nullable?: boolean }>;
  foreignKeys: Array<{
    column: string;
    referencedSchema: string;
    referencedTable: string;
    referencedColumn: string;
  }>;
};

type ColumnMetadataRow = {
  table_schema: string; table_name: string; column_name: string; data_type: string;
  udt_schema: string; udt_name: string;
  character_maximum_length: number | null; numeric_precision: number | null; numeric_scale: number | null;
  is_generated?: string;
  is_nullable?: string;
  is_identity?: string;
  has_default?: boolean;
};
type PrimaryKeyMetadataRow = { table_schema: string; table_name: string; column_name: string };
type ForeignKeyMetadataRow = {
  table_schema: string; table_name: string; column_name: string;
  referenced_schema: string; referenced_table: string; referenced_column: string;
};

export function assemblePostgresSchema(
  columnRows: ColumnMetadataRow[],
  primaryKeyRows: PrimaryKeyMetadataRow[],
  foreignKeyRows: ForeignKeyMetadataRow[],
): PostgresSchemaTable[] {
  const tables = new Map<string, PostgresSchemaTable>();
  const tableKey = (schema: string, name: string) => JSON.stringify([schema, name]);
  const formatType = (row: ColumnMetadataRow) => {
    if (row.data_type === 'USER-DEFINED') return `${row.udt_schema}.${row.udt_name}`;
    if (row.data_type === 'ARRAY') {
      const schemaPrefix = row.udt_schema === 'pg_catalog' ? '' : `${row.udt_schema}.`;
      return `${schemaPrefix}${row.udt_name.replace(/^_/, '')}[]`;
    }
    if (row.character_maximum_length) {
      const base = row.data_type === 'character varying' ? 'varchar' : row.data_type === 'character' ? 'char' : row.data_type;
      return `${base}(${row.character_maximum_length})`;
    }
    if (row.data_type === 'numeric' && row.numeric_precision !== null) {
      return `numeric(${row.numeric_precision},${row.numeric_scale ?? 0})`;
    }
    return row.data_type;
  };

  for (const row of columnRows) {
    const key = tableKey(row.table_schema, row.table_name);
    const table = tables.get(key) ?? { schema: row.table_schema, name: row.table_name, columns: [], foreignKeys: [] };
    table.columns.push({ name: row.column_name, type: formatType(row), ...(row.is_generated === 'ALWAYS' ? { generated: true } : {}), ...(row.is_nullable ? { nullable: row.is_nullable === 'YES' } : {}), ...(row.is_identity === 'YES' ? { identity: true } : {}), ...(row.has_default ? { hasDefault: true } : {}) });
    tables.set(key, table);
  }
  for (const row of primaryKeyRows) {
    const column = tables.get(tableKey(row.table_schema, row.table_name))?.columns.find((item) => item.name === row.column_name);
    if (column) column.key = 'pk';
  }
  for (const row of foreignKeyRows) {
    const table = tables.get(tableKey(row.table_schema, row.table_name));
    const column = table?.columns.find((item) => item.name === row.column_name);
    if (column) column.key = column.key === 'pk' ? 'pk-fk' : 'fk';
    table?.foreignKeys.push({
      column: row.column_name,
      referencedSchema: row.referenced_schema,
      referencedTable: row.referenced_table,
      referencedColumn: row.referenced_column,
    });
  }
  return [...tables.values()];
}

type PostgresSession = { pool: Pool; database: string; lastUsedAt: number };
const postgresSessions = new Map<string, PostgresSession>();
type MysqlSession = { pool: mysql.Pool; database: string; lastUsedAt: number };
const mysqlSessions = new Map<string, MysqlSession>();
export type DatabaseSession =
  | ({ engine: 'postgres' } & PostgresSession)
  | ({ engine: 'mysql' } & MysqlSession);
const SESSION_IDLE_TTL_MS = 15 * 60 * 1000;
const MAX_POSTGRES_SESSIONS = 5;
const MAX_MYSQL_SESSIONS = 5;

export class PostgresSessionLimitError extends Error {}
export class PostgresTableNotFoundError extends Error {}
export class PostgresResultSizeError extends Error {}
export class RecordSortColumnError extends Error {}
export class ReadOnlyQueryValidationError extends Error {}
export class DatabaseQueryResultSizeError extends Error {}

const MAX_READ_QUERY_LENGTH = 50_000;
const MAX_READ_QUERY_ROWS = 1_000;

/** Allows one SELECT or CTE statement. Read-only transactions provide the engine-level guard. */
export function validateReadOnlyQuery(source: string, engine: ConnectionInput['engine']) {
  const query = source.trim();
  if (!query || source.length > MAX_READ_QUERY_LENGTH) {
    throw new ReadOnlyQueryValidationError(`Enter a query under ${MAX_READ_QUERY_LENGTH.toLocaleString()} characters.`);
  }
  const unsafeFunctions = /(?:^|[^A-Za-z0-9_])(?:LOAD_FILE|SLEEP|BENCHMARK|GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|IS_FREE_LOCK|IS_USED_LOCK|LAST_INSERT_ID|NEXTVAL|SETVAL|PG_SLEEP|PG_ADVISORY_[A-Z0-9_]+|PG_NOTIFY|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_DIR|LO_IMPORT|LO_EXPORT|DBLINK(?:_EXEC)?)\s*\(/i;
  if (unsafeFunctions.test(query)) {
    throw new ReadOnlyQueryValidationError('This function can change database or session state and is not allowed in read-only queries.');
  }

  const tokens: string[] = [];
  let semicolon = -1;
  let index = 0;
  const skipQuoted = (quote: string) => {
    index += 1;
    while (index < query.length) {
      if (query[index] === quote) {
        if (query[index + 1] === quote) { index += 2; continue; }
        index += 1;
        return true;
      }
      if (quote === "'" && query[index] === '\\' && index + 1 < query.length) index += 2;
      else index += 1;
    }
    return false;
  };

  while (index < query.length) {
    const character = query[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (query.startsWith('--', index) || (character === '#' && engine === 'mysql')) {
      const end = query.indexOf('\n', index + (character === '#' ? 1 : 2));
      index = end < 0 ? query.length : end + 1;
      continue;
    }
    if (query.startsWith('/*', index)) {
      index += 2;
      let depth = 1;
      while (index < query.length && depth > 0) {
        if (query.startsWith('/*', index)) { depth += 1; index += 2; }
        else if (query.startsWith('*/', index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth > 0) throw new ReadOnlyQueryValidationError('The query contains an unfinished block comment.');
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      if (!skipQuoted(character)) throw new ReadOnlyQueryValidationError('The query contains an unfinished quoted value or identifier.');
      continue;
    }
    if (character === '$') {
      const dollarQuote = query.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (dollarQuote) {
        const end = query.indexOf(dollarQuote, index + dollarQuote.length);
        if (end < 0) throw new ReadOnlyQueryValidationError('The query contains an unfinished dollar-quoted value.');
        index = end + dollarQuote.length;
        continue;
      }
    }
    if (character === ';') {
      if (semicolon >= 0) throw new ReadOnlyQueryValidationError('Run one statement at a time.');
      semicolon = index;
      index += 1;
      continue;
    }
    if (semicolon >= 0) throw new ReadOnlyQueryValidationError('Run one statement at a time.');
    if (/[A-Za-z_]/.test(character)) {
      const word = query.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0] ?? character;
      tokens.push(word.toUpperCase());
      index += word.length;
      continue;
    }
    if (query.startsWith(':=', index) || character === '@') {
      throw new ReadOnlyQueryValidationError('Session-variable assignments are not allowed in read-only queries.');
    }
    index += 1;
  }

  if (tokens[0] !== 'SELECT' && tokens[0] !== 'WITH') {
    throw new ReadOnlyQueryValidationError('Only SELECT queries and read-only common table expressions are allowed.');
  }
  const forbidden = new Set([
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
    'GRANT', 'REVOKE', 'CALL', 'DO', 'EXEC', 'EXECUTE', 'SET', 'RESET', 'BEGIN', 'START', 'COMMIT',
    'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'LOCK', 'UNLOCK', 'USE', 'INTO', 'OUTFILE', 'DUMPFILE',
    'LOAD', 'IMPORT', 'VACUUM', 'ANALYZE', 'REFRESH',
  ]);
  const prohibited = tokens.find((token) => forbidden.has(token));
  if (prohibited) throw new ReadOnlyQueryValidationError(`The ${prohibited} keyword is not allowed in read-only queries.`);
  for (let tokenIndex = 0; tokenIndex < tokens.length - 1; tokenIndex += 1) {
    if (tokens[tokenIndex] === 'FOR' && (tokens[tokenIndex + 1] === 'UPDATE' || tokens[tokenIndex + 1] === 'SHARE')) {
      throw new ReadOnlyQueryValidationError('Row-locking clauses are not allowed in read-only queries.');
    }
    if (tokens[tokenIndex] === 'SHARE' && tokens[tokenIndex + 1] === 'MODE') {
      throw new ReadOnlyQueryValidationError('Row-locking clauses are not allowed in read-only queries.');
    }
  }
  return semicolon >= 0 ? query.slice(0, semicolon).trim() : query;
}

function expireIdlePostgresSessions() {
  const expiredBefore = Date.now() - SESSION_IDLE_TTL_MS;
  for (const [id, session] of postgresSessions) {
    if (session.lastUsedAt < expiredBefore) {
      postgresSessions.delete(id);
      void session.pool.end().catch(() => undefined);
    }
  }
}

function expireIdleMysqlSessions() {
  const expiredBefore = Date.now() - SESSION_IDLE_TTL_MS;
  for (const [id, session] of mysqlSessions) {
    if (session.lastUsedAt < expiredBefore) {
      mysqlSessions.delete(id);
      void session.pool.end().catch(() => undefined);
    }
  }
}

function expireIdleSessions() {
  expireIdlePostgresSessions();
  expireIdleMysqlSessions();
}

const postgresSessionCleanup = setInterval(expireIdlePostgresSessions, 60_000);
postgresSessionCleanup.unref();
const mysqlSessionCleanup = setInterval(expireIdleMysqlSessions, 60_000);
mysqlSessionCleanup.unref();

/** Opens an in-memory PostgreSQL pool. The returned opaque token is transient and expires after 15 idle minutes. */
export async function openPostgresSession(input: ConnectionInput) {
  if (input.engine !== 'postgres') throw new Error('This session requires PostgreSQL.');
  expireIdlePostgresSessions();
  if (postgresSessions.size >= MAX_POSTGRES_SESSIONS) throw new PostgresSessionLimitError();
  const endpoint = await resolveDatabaseHost(input.host);

  const pool = new Pool({
    host: endpoint.address,
    port: input.port,
    database: input.database,
    user: input.username,
    password: input.password,
    ssl: input.ssl ? { rejectUnauthorized: true, ...(endpoint.tlsServername ? { servername: endpoint.tlsServername } : {}) } : false,
    max: 2,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 7000,
    statement_timeout: 7000,
    query_timeout: 8000,
    application_name: 'idp-local-workspace',
  });
  const started = Date.now();
  try {
    const client = await pool.connect();
    let serverVersion = 'PostgreSQL';
    try {
      const result = await client.query<{ version: string }>('SELECT version() AS version');
      serverVersion = result.rows[0]?.version?.split(' ').slice(0, 2).join(' ') ?? serverVersion;
    } finally {
      client.release();
    }
    expireIdlePostgresSessions();
    if (postgresSessions.size >= MAX_POSTGRES_SESSIONS) throw new PostgresSessionLimitError();
    const connectionId = randomBytes(32).toString('hex');
    postgresSessions.set(connectionId, { pool, database: input.database, lastUsedAt: Date.now() });
    return { success: true as const, engine: 'postgres' as const, connectionId, latencyMs: Date.now() - started, serverVersion, expiresInSeconds: SESSION_IDLE_TTL_MS / 1000 };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

async function openMysqlSession(input: ConnectionInput) {
  if (input.engine !== 'mysql') throw new Error('This session requires MySQL.');
  expireIdleMysqlSessions();
  if (mysqlSessions.size >= MAX_MYSQL_SESSIONS) throw new PostgresSessionLimitError();
  const endpoint = await resolveDatabaseHost(input.host);
  const pool = mysql.createPool({
    // Keep the original DNS name for mysql2's TLS identity check while the custom stream
    // pins TCP to the address already checked by resolveDatabaseHost.
    host: endpoint.tlsServername ?? endpoint.address,
    port: input.port,
    database: input.database,
    user: input.username,
    password: input.password,
    ssl: input.ssl ? { rejectUnauthorized: true } : undefined,
    stream: () => netConnect({ host: endpoint.address, port: input.port }),
    connectionLimit: 2,
    connectTimeout: 7000,
    enableKeepAlive: false,
    multipleStatements: false,
  });
  const started = Date.now();
  try {
    const [rows] = await pool.query({ sql: 'SELECT VERSION() AS version', timeout: 8000 });
    const serverVersion = (rows as Array<{ version: string }>)[0]?.version ?? 'MySQL';
    expireIdleMysqlSessions();
    if (mysqlSessions.size >= MAX_MYSQL_SESSIONS) throw new PostgresSessionLimitError();
    const connectionId = randomBytes(32).toString('hex');
    mysqlSessions.set(connectionId, { pool, database: input.database, lastUsedAt: Date.now() });
    return { success: true as const, engine: 'mysql' as const, connectionId, latencyMs: Date.now() - started, serverVersion, expiresInSeconds: SESSION_IDLE_TTL_MS / 1000 };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

export async function openDatabaseSession(input: ConnectionInput) {
  return input.engine === 'postgres' ? openPostgresSession(input) : openMysqlSession(input);
}

export function getPostgresSession(connectionId: string) {
  expireIdlePostgresSessions();
  const session = postgresSessions.get(connectionId);
  if (!session) return null;
  session.lastUsedAt = Date.now();
  return session;
}

export function getDatabaseSession(connectionId: string): DatabaseSession | null {
  expireIdleSessions();
  const postgres = postgresSessions.get(connectionId);
  if (postgres) {
    postgres.lastUsedAt = Date.now();
    return { engine: 'postgres', ...postgres };
  }
  const mysqlSession = mysqlSessions.get(connectionId);
  if (mysqlSession) {
    mysqlSession.lastUsedAt = Date.now();
    return { engine: 'mysql', ...mysqlSession };
  }
  return null;
}

export async function closePostgresSession(connectionId: string) {
  const session = postgresSessions.get(connectionId);
  if (!session) return false;
  postgresSessions.delete(connectionId);
  await session.pool.end().catch(() => undefined);
  return true;
}

export async function closeDatabaseSession(connectionId: string) {
  if (await closePostgresSession(connectionId)) return true;
  const session = mysqlSessions.get(connectionId);
  if (!session) return false;
  mysqlSessions.delete(connectionId);
  await session.pool.end().catch(() => undefined);
  return true;
}

/** Tests a connection only. Credentials are never persisted and should not be logged. */
export async function testDatabaseConnection(input: ConnectionInput) {
  const endpoint = await resolveDatabaseHost(input.host);
  const started = Date.now();
  if (input.engine === 'postgres') {
    const client = new PgClient({
      host: endpoint.address, port: input.port, database: input.database,
      user: input.username, password: input.password,
      ssl: input.ssl ? { rejectUnauthorized: true, ...(endpoint.tlsServername ? { servername: endpoint.tlsServername } : {}) } : false,
      connectionTimeoutMillis: 7000,
      statement_timeout: 7000,
      application_name: 'idp-connection-test',
    });
    try {
      await client.connect();
      const result = await client.query<{ version: string }>('SELECT version() AS version');
      return { success: true, engine: input.engine, latencyMs: Date.now() - started, serverVersion: result.rows[0]?.version?.split(' ').slice(0, 2).join(' ') ?? 'PostgreSQL' };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  const connection = await mysql.createConnection({
    host: endpoint.tlsServername ?? endpoint.address, port: input.port, database: input.database,
    user: input.username, password: input.password,
    ssl: input.ssl ? { rejectUnauthorized: true } : undefined,
    stream: () => netConnect({ host: endpoint.address, port: input.port }),
    connectTimeout: 7000,
    enableKeepAlive: false,
  });
  try {
    const [rows] = await connection.query({ sql: 'SELECT VERSION() AS version', timeout: 8000 });
    const firstRow = (rows as Array<{ version: string }>)[0];
    return { success: true, engine: input.engine, latencyMs: Date.now() - started, serverVersion: firstRow?.version ?? 'MySQL' };
  } finally {
    await connection.end().catch(() => undefined);
  }
}

/** Read PostgreSQL catalog metadata only through an active, expiring local session. */
export async function introspectPostgresSchema(session: PostgresSession) {
  const client = await session.pool.connect();
  try {
    const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    const versionNumber = Number(version.rows[0]?.server_version_num);
    const generatedColumn = versionNumber >= 120000 ? 'c.is_generated' : "'NEVER'::text AS is_generated";
    const identityColumn = versionNumber >= 100000 ? 'c.is_identity' : "'NO'::text AS is_identity";
    const [columnResult, primaryKeyResult, foreignKeyResult] = await Promise.all([
      client.query<ColumnMetadataRow>(`
        SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.udt_schema, c.udt_name,
               c.character_maximum_length, c.numeric_precision, c.numeric_scale, ${generatedColumn}, ${identityColumn}, c.column_default IS NOT NULL AS has_default, c.is_nullable
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE t.table_type = 'BASE TABLE'
          AND c.table_schema NOT IN ('information_schema', 'pg_catalog')
          AND left(c.table_schema, 3) <> 'pg_'
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
        LIMIT 10001
      `),
      client.query<PrimaryKeyMetadataRow>(`
        SELECT tc.table_schema, tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_catalog = tc.constraint_catalog
         AND kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
         AND kcu.table_name = tc.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema NOT IN ('information_schema', 'pg_catalog')
          AND left(tc.table_schema, 3) <> 'pg_'
        LIMIT 10001
      `),
      client.query<ForeignKeyMetadataRow>(`
        SELECT source_ns.nspname AS table_schema,
               source_table.relname AS table_name,
               source_column.attname AS column_name,
               target_ns.nspname AS referenced_schema,
               target_table.relname AS referenced_table,
               target_column.attname AS referenced_column
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class source_table ON source_table.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source_table.relnamespace
        JOIN pg_catalog.pg_class target_table ON target_table.oid = constraint_row.confrelid
        JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target_table.relnamespace
        CROSS JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
          WITH ORDINALITY AS key_pair(source_attnum, target_attnum, position)
        JOIN pg_catalog.pg_attribute source_column
          ON source_column.attrelid = source_table.oid AND source_column.attnum = key_pair.source_attnum
        JOIN pg_catalog.pg_attribute target_column
          ON target_column.attrelid = target_table.oid AND target_column.attnum = key_pair.target_attnum
        JOIN information_schema.tables visible_source
          ON visible_source.table_schema = source_ns.nspname AND visible_source.table_name = source_table.relname
         AND visible_source.table_type = 'BASE TABLE'
        JOIN information_schema.tables visible_target
          ON visible_target.table_schema = target_ns.nspname AND visible_target.table_name = target_table.relname
         AND visible_target.table_type = 'BASE TABLE'
        WHERE constraint_row.contype = 'f'
          AND source_ns.nspname NOT IN ('information_schema', 'pg_catalog')
          AND left(source_ns.nspname, 3) <> 'pg_'
        ORDER BY source_ns.nspname, source_table.relname, constraint_row.conname, key_pair.position
        LIMIT 10001
      `),
    ]);

    if (columnResult.rows.length > 10000 || primaryKeyResult.rows.length > 10000 || foreignKeyResult.rows.length > 10000) {
      throw new Error('The database schema exceeds the current introspection limit.');
    }

    return {
      engine: 'postgres' as const,
      database: session.database,
      introspectedAt: new Date().toISOString(),
      tables: assemblePostgresSchema(columnResult.rows, primaryKeyResult.rows, foreignKeyResult.rows),
    };
  } finally {
    client.release();
  }
}

type MysqlColumnMetadataRow = { table_schema: string; table_name: string; column_name: string; column_type: string; is_generated?: string; is_nullable?: string; column_default?: unknown; extra?: string };
type MysqlPrimaryKeyMetadataRow = { table_schema: string; table_name: string; column_name: string };
type MysqlForeignKeyMetadataRow = {
  table_schema: string; table_name: string; column_name: string;
  referenced_schema: string; referenced_table: string; referenced_column: string;
};

export function assembleMysqlSchema(
  columnRows: MysqlColumnMetadataRow[],
  primaryKeyRows: MysqlPrimaryKeyMetadataRow[],
  foreignKeyRows: MysqlForeignKeyMetadataRow[],
): PostgresSchemaTable[] {
  const tables = new Map<string, PostgresSchemaTable>();
  const tableKey = (schema: string, name: string) => JSON.stringify([schema, name]);
  for (const row of columnRows) {
    const key = tableKey(row.table_schema, row.table_name);
    const table = tables.get(key) ?? { schema: row.table_schema, name: row.table_name, columns: [], foreignKeys: [] };
    table.columns.push({ name: row.column_name, type: row.column_type, ...(row.is_generated === 'ALWAYS' ? { generated: true } : {}), ...(row.is_nullable ? { nullable: row.is_nullable === 'YES' } : {}), ...(row.column_default !== null && row.column_default !== undefined ? { hasDefault: true } : {}), ...(/auto_increment/i.test(row.extra ?? '') ? { identity: true } : {}) });
    tables.set(key, table);
  }
  for (const row of primaryKeyRows) {
    const column = tables.get(tableKey(row.table_schema, row.table_name))?.columns.find((item) => item.name === row.column_name);
    if (column) column.key = 'pk';
  }
  for (const row of foreignKeyRows) {
    const table = tables.get(tableKey(row.table_schema, row.table_name));
    const column = table?.columns.find((item) => item.name === row.column_name);
    if (column) column.key = column.key === 'pk' ? 'pk-fk' : 'fk';
    table?.foreignKeys.push({
      column: row.column_name,
      referencedSchema: row.referenced_schema,
      referencedTable: row.referenced_table,
      referencedColumn: row.referenced_column,
    });
  }
  return [...tables.values()];
}

async function introspectMysqlSchema(session: MysqlSession) {
  const [columnRows, primaryKeyRows, foreignKeyRows] = await Promise.all([
    session.pool.query({ sql: `
      SELECT c.table_schema, c.table_name, c.column_name, c.column_type, c.is_generated, c.is_nullable, c.column_default, c.extra
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = ? AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position
      LIMIT 10001
    `, timeout: 8000 }, [session.database]),
    session.pool.query({ sql: `
      SELECT table_schema, table_name, column_name
      FROM information_schema.key_column_usage
      WHERE table_schema = ? AND constraint_name = 'PRIMARY'
      LIMIT 10001
    `, timeout: 8000 }, [session.database]),
    session.pool.query({ sql: `
      SELECT table_schema, table_name, column_name,
             referenced_table_schema AS referenced_schema,
             referenced_table_name AS referenced_table,
             referenced_column_name AS referenced_column
      FROM information_schema.key_column_usage
      WHERE table_schema = ? AND referenced_table_name IS NOT NULL
      ORDER BY table_name, constraint_name, ordinal_position
      LIMIT 10001
    `, timeout: 8000 }, [session.database]),
  ]);
  const columns = columnRows[0] as MysqlColumnMetadataRow[];
  const primaryKeys = primaryKeyRows[0] as MysqlPrimaryKeyMetadataRow[];
  const foreignKeys = foreignKeyRows[0] as MysqlForeignKeyMetadataRow[];
  if (columns.length > 10000 || primaryKeys.length > 10000 || foreignKeys.length > 10000) {
    throw new Error('The database schema exceeds the current introspection limit.');
  }
  return {
    engine: 'mysql' as const,
    database: session.database,
    introspectedAt: new Date().toISOString(),
    tables: assembleMysqlSchema(columns, primaryKeys, foreignKeys),
  };
}

export async function introspectDatabaseSchema(session: DatabaseSession) {
  if (session.engine === 'postgres') return introspectPostgresSchema(session);
  return introspectMysqlSchema(session);
}

function quotePostgresIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export type RecordPageSort = { column: string; direction: 'asc' | 'desc' };

function pageOrder(sort: RecordPageSort | undefined, primaryKeys: string[], quote: (identifier: string) => string) {
  if (sort && (!sort.column || !['asc', 'desc'].includes(sort.direction))) throw new TypeError('Invalid record sort.');
  const order = sort ? [`${quote(sort.column)} ${sort.direction.toUpperCase()}`] : [];
  for (const key of primaryKeys) {
    if (key !== sort?.column) order.push(`${quote(key)} ASC`);
  }
  return order.length ? ` ORDER BY ${order.join(', ')}` : '';
}

function searchablePredicate(columns: string[], value: string, startIndex: number, quote: (identifier: string) => string, cast: (identifier: string) => string, placeholder: (index: number) => string) {
  if (!value || columns.length === 0) return { sql: '', values: [] as string[] };
  const escaped = value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
  const parameter = placeholder(startIndex);
  const sql = columns.map((column) => `${cast(quote(column))} ILIKE ${parameter} ESCAPE '!'`).join(' OR ');
  return { sql: ` WHERE (${sql})`, values: [`%${escaped}%`] };
}

export function buildPostgresPageQuery(schema: string, table: string, page: number, pageSize: number, sort?: RecordPageSort, primaryKeys: string[] = [], search = '', columns: string[] = []) {
  if (!Number.isInteger(page) || page < 0 || page > 10_000) throw new RangeError('Page is outside the supported range.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RangeError('Page size is outside the supported range.');
  const predicate = searchablePredicate(columns, search, 1, quotePostgresIdentifier, (value) => `${value}::text`, (index) => `$${index}`);
  const limitIndex = predicate.values.length + 1;
  return {
    text: `SELECT * FROM ${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}${predicate.sql}${pageOrder(sort, primaryKeys, quotePostgresIdentifier)} LIMIT $${limitIndex} OFFSET $${limitIndex + 1}`,
    values: [...predicate.values, pageSize + 1, page * pageSize],
  };
}

function quoteMysqlIdentifier(identifier: string) {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

export function buildMysqlPageQuery(schema: string, table: string, page: number, pageSize: number, sort?: RecordPageSort, primaryKeys: string[] = [], search = '', columns: string[] = []) {
  if (!Number.isInteger(page) || page < 0 || page > 10_000) throw new RangeError('Page is outside the supported range.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RangeError('Page size is outside the supported range.');
  const predicate = searchablePredicate(columns, search, 0, quoteMysqlIdentifier, (value) => `CAST(${value} AS CHAR)`, () => '?');
  return {
    text: `SELECT * FROM ${quoteMysqlIdentifier(schema)}.${quoteMysqlIdentifier(table)}${predicate.sql.replaceAll('ILIKE', 'LIKE')}${pageOrder(sort, primaryKeys, quoteMysqlIdentifier)} LIMIT ? OFFSET ?`,
    values: [...predicate.values, pageSize + 1, page * pageSize],
  };
}

/** Reads at most 101 visible rows and safely quotes names confirmed through information_schema. */
export async function readPostgresTablePage(session: PostgresSession, schema: string, table: string, page: number, pageSize: number, sort?: RecordPageSort, search = '') {
  const client = await session.pool.connect();
  try {
    const metadata = await client.query<{ table_name: string; column_name: string | null }>(`
      SELECT t.table_name, kcu.column_name
      FROM information_schema.tables t
      LEFT JOIN information_schema.table_constraints tc
        ON tc.table_catalog = t.table_catalog AND tc.table_schema = t.table_schema
        AND tc.table_name = t.table_name AND tc.constraint_type = 'PRIMARY KEY'
      LEFT JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_catalog = tc.constraint_catalog AND kcu.constraint_schema = tc.constraint_schema
        AND kcu.constraint_name = tc.constraint_name AND kcu.table_schema = t.table_schema
        AND kcu.table_name = t.table_name
      WHERE t.table_schema = $1 AND t.table_name = $2 AND t.table_type = 'BASE TABLE'
        AND t.table_schema NOT IN ('information_schema', 'pg_catalog')
        AND left(t.table_schema, 3) <> 'pg_'
      ORDER BY kcu.ordinal_position
    `, [schema, table]);
    if (metadata.rows.length === 0) throw new PostgresTableNotFoundError();
    const primaryKeys = metadata.rows.flatMap((row) => row.column_name ? [row.column_name] : []);
    const columnResult = await client.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position', [schema, table],
    );
    const visibleColumns = columnResult.rows.map((row) => row.column_name);
    if (sort) {
      const columns = await client.query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3', [schema, table, sort.column],
      );
      if (columns.rows.length === 0) throw new RecordSortColumnError('Choose a visible column to sort this table.');
    }
    const query = buildPostgresPageQuery(schema, table, page, pageSize, sort, primaryKeys, search, visibleColumns);
    const result = await client.query(query.text, query.values);
    const rows = result.rows.slice(0, pageSize);
    if (Buffer.byteLength(JSON.stringify(rows), 'utf8') > 2_000_000) throw new PostgresResultSizeError();
    return {
      page,
      pageSize,
      hasMore: result.rows.length > pageSize,
      rows,
    };
  } finally {
    client.release();
  }
}

async function readMysqlTablePage(session: MysqlSession, schema: string, table: string, page: number, pageSize: number, sort?: RecordPageSort, search = '') {
  const [metadataRows] = await session.pool.query({ sql: `
    SELECT t.TABLE_NAME AS table_name, kcu.COLUMN_NAME AS column_name
    FROM information_schema.tables t
    LEFT JOIN information_schema.key_column_usage kcu
      ON kcu.TABLE_SCHEMA = t.TABLE_SCHEMA AND kcu.TABLE_NAME = t.TABLE_NAME AND kcu.CONSTRAINT_NAME = 'PRIMARY'
    WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ? AND t.TABLE_TYPE = 'BASE TABLE'
    ORDER BY kcu.ORDINAL_POSITION
  `, timeout: 8000 }, [session.database, table]);
  if ((metadataRows as unknown[]).length === 0 || schema !== session.database) throw new PostgresTableNotFoundError();
  const primaryKeys = (metadataRows as Array<{ column_name: string | null }>).flatMap((row) => row.column_name ? [row.column_name] : []);
  const [columnRows] = await session.pool.query({ sql: 'SELECT COLUMN_NAME AS column_name FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', timeout: 8000 }, [schema, table]);
  const visibleColumns = (columnRows as Array<{ column_name: string }>).map((row) => row.column_name);
  if (sort) {
    const [columnRows] = await session.pool.query({ sql: 'SELECT COLUMN_NAME AS column_name FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', timeout: 8000 }, [schema, table, sort.column]);
    if (!(columnRows as unknown[]).length) throw new RecordSortColumnError('Choose a visible column to sort this table.');
  }
  const query = buildMysqlPageQuery(schema, table, page, pageSize, sort, primaryKeys, search, visibleColumns);
  const [result] = await session.pool.query({ sql: query.text, timeout: 8000 }, query.values);
  const resultRows = result as Array<Record<string, unknown>>;
  const rows = resultRows.slice(0, pageSize);
  if (Buffer.byteLength(JSON.stringify(rows), 'utf8') > 2_000_000) throw new PostgresResultSizeError();
  return { page, pageSize, hasMore: resultRows.length > pageSize, rows };
}

export async function readDatabaseTablePage(session: DatabaseSession, schema: string, table: string, page: number, pageSize: number, sort?: RecordPageSort, search = '') {
  if (session.engine === 'postgres') return readPostgresTablePage(session, schema, table, page, pageSize, sort, search);
  return readMysqlTablePage(session, schema, table, page, pageSize, sort, search);
}

export type DatabaseQueryResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
};

function assembleQueryResult(
  columns: string[],
  resultRows: Array<Record<string, unknown>>,
  startedAt: number,
): DatabaseQueryResult {
  const rows = resultRows.slice(0, MAX_READ_QUERY_ROWS);
  if (Buffer.byteLength(JSON.stringify(rows), 'utf8') > 2_000_000) throw new DatabaseQueryResultSizeError();
  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated: resultRows.length > MAX_READ_QUERY_ROWS,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Executes a single SELECT inside a read-only transaction and bounds returned rows and payload size. */
export async function executeDatabaseQuery(session: DatabaseSession, source: string): Promise<DatabaseQueryResult> {
  const query = validateReadOnlyQuery(source, session.engine);
  const startedAt = Date.now();
  const boundedQuery = `SELECT * FROM (\n${query}\n) AS __idp_query_result LIMIT ${MAX_READ_QUERY_ROWS + 1}`;

  if (session.engine === 'postgres') {
    const client = await session.pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN READ ONLY');
      transactionStarted = true;
      const result = await client.query(boundedQuery);
      return assembleQueryResult(result.fields.map((field) => field.name), result.rows, startedAt);
    } finally {
      if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  const connection = await session.pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.query('START TRANSACTION READ ONLY');
    transactionStarted = true;
    const [rows, fields] = await connection.query({ sql: boundedQuery, timeout: 8000 });
    return assembleQueryResult(
      (fields as Array<{ name: string }>).map((field) => field.name),
      rows as Array<Record<string, unknown>>,
      startedAt,
    );
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => undefined);
    connection.release();
  }
}
