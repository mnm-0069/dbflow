import type { DatabaseSession } from './connection-service.js';

export class RecordUpdateError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type RecordUpdate = { schema: string; table: string; primaryKey: Record<string, unknown>; originalValues: Record<string, unknown>; changes: Record<string, unknown> };

function assertScalar(value: unknown, label: string) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 100_000)) return;
  throw new RecordUpdateError(`${label} must be a string, finite number, boolean, or NULL.`);
}

function quote(identifier: string, engine: DatabaseSession['engine']) {
  return engine === 'postgres' ? `"${identifier.replaceAll('"', '""')}"` : `\`${identifier.replaceAll('`', '``')}\``;
}

function validateInput(input: RecordUpdate) {
  if (!input.schema.trim() || !input.table.trim()) throw new RecordUpdateError('Choose a schema and table.');
  const keys = Object.keys(input.primaryKey ?? {});
  const changes = Object.keys(input.changes ?? {});
  if (!keys.length || keys.length > 10) throw new RecordUpdateError('This table needs a visible primary key to update rows.');
  if (!changes.length || changes.length > 50) throw new RecordUpdateError('Change between 1 and 50 non-key columns.');
  for (const key of keys) { if (input.primaryKey[key] === null) throw new RecordUpdateError(`Primary-key value “${key}” cannot be NULL.`); assertScalar(input.primaryKey[key], `Primary-key value “${key}”`); }
  for (const column of changes) assertScalar(input.changes[column], `Value for “${column}”`);
  if (changes.length !== Object.keys(input.originalValues ?? {}).length || changes.some((column) => !Object.hasOwn(input.originalValues, column))) {
    throw new RecordUpdateError('Include the original value for every changed column so concurrent edits can be detected.');
  }
  for (const column of changes) assertScalar(input.originalValues[column], `Original value for “${column}”`);
  return { keys, changes };
}

async function visibleTableMetadata(session: DatabaseSession, schema: string, table: string) {
  if (session.engine === 'postgres') {
    if (['information_schema', 'pg_catalog'].includes(schema) || schema.startsWith('pg_')) throw new RecordUpdateError('System schemas cannot be edited.', 403);
    const tableResult = await session.pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE') AS exists", [schema, table],
    );
    if (!tableResult.rows[0]?.exists) throw new RecordUpdateError('That base table is not visible in this database session.', 404);
    const keyResult = await session.pool.query<{ column_name: string }>(`
      SELECT kcu.column_name FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_catalog = kcu.constraint_catalog
        AND tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
      ORDER BY kcu.ordinal_position
    `, [schema, table]);
    const columnResult = await session.pool.query<{ column_name: string; is_generated: string }>(
      'SELECT column_name, is_generated FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [schema, table],
    );
    return { keys: keyResult.rows.map((row) => row.column_name), columns: new Map(columnResult.rows.map((row) => [row.column_name, row.is_generated])) };
  }
  if (schema !== session.database) throw new RecordUpdateError('MySQL row updates are limited to the connected database.', 400);
  const [tableRows] = await session.pool.query("SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'", [schema, table]);
  if (!(tableRows as unknown[]).length) throw new RecordUpdateError('That base table is not visible in this database session.', 404);
  const [keyRows] = await session.pool.query(`
    SELECT COLUMN_NAME AS column_name FROM information_schema.key_column_usage
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
    ORDER BY ORDINAL_POSITION
  `, [schema, table]);
  const [columnRows] = await session.pool.query('SELECT COLUMN_NAME AS column_name, IS_GENERATED AS is_generated FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [schema, table]);
  return {
    keys: (keyRows as Array<{ column_name: string }>).map((row) => row.column_name),
    columns: new Map((columnRows as Array<{ column_name: string; is_generated: string }>).map((row) => [row.column_name, row.is_generated])),
  };
}

export async function updateDatabaseRecord(session: DatabaseSession, input: RecordUpdate) {
  const { keys, changes } = validateInput(input);
  const metadata = await visibleTableMetadata(session, input.schema, input.table);
  if (!metadata.keys.length) throw new RecordUpdateError('Rows can only be edited when the table has a primary key.', 409);
  if (keys.length !== metadata.keys.length || metadata.keys.some((key) => !Object.hasOwn(input.primaryKey, key))) {
    throw new RecordUpdateError('Provide every primary-key value for this table.', 400);
  }
  const primaryKeySet = new Set(metadata.keys);
  for (const column of changes) {
    const generated = metadata.columns.get(column);
    if (generated === undefined) throw new RecordUpdateError(`Column “${column}” is not visible on this table.`, 400);
    if (primaryKeySet.has(column)) throw new RecordUpdateError('Primary-key columns cannot be changed in this editor.', 400);
    if (generated !== 'NEVER') throw new RecordUpdateError(`Generated column “${column}” cannot be edited.`, 400);
  }
  const tableName = `${quote(input.schema, session.engine)}.${quote(input.table, session.engine)}`;
  const setColumns = changes.map((column) => quote(column, session.engine));
  const keyColumns = metadata.keys.map((column) => quote(column, session.engine));
  if (session.engine === 'postgres') {
    const values = changes.map((column) => input.changes[column]);
    const setSql = changes.map((column, index) => `${setColumns[index]} = $${index + 1}`).join(', ');
    const keySql = metadata.keys.map((column, index) => `${keyColumns[index]} = $${changes.length + index + 1}`).join(' AND ');
    const originalSql = changes.map((column, index) => `${quote(column, session.engine)} IS NOT DISTINCT FROM $${changes.length + metadata.keys.length + index + 1}`).join(' AND ');
    const whereSql = `${keySql} AND ${originalSql}`;
    const originalValues = changes.map((column) => input.originalValues[column]);
    const result = await session.pool.query(`UPDATE ${tableName} SET ${setSql} WHERE ${whereSql} RETURNING 1`, [...values, ...metadata.keys.map((column) => input.primaryKey[column]), ...originalValues]);
    if (result.rowCount !== 1) throw new RecordUpdateError('This row changed or was removed. Refresh the page and try again.', 409);
    return { success: true as const, affectedRows: 1 };
  }
  const connection = await session.pool.getConnection();
  try {
    await connection.beginTransaction();
    const keyWhereSql = metadata.keys.map((column) => `${quote(column, session.engine)} = ?`).join(' AND ');
    const originalWhereSql = changes.map((column) => `${quote(column, session.engine)} <=> ?`).join(' AND ');
    const whereSql = `${keyWhereSql} AND ${originalWhereSql}`;
    const whereValues = [...metadata.keys.map((column) => input.primaryKey[column]), ...changes.map((column) => input.originalValues[column])];
    const [matches] = await connection.query(`SELECT 1 FROM ${tableName} WHERE ${whereSql} LIMIT 1 FOR UPDATE`, whereValues);
    if (!(matches as unknown[]).length) throw new RecordUpdateError('This row changed or was removed. Refresh the page and try again.', 409);
    const setSql = changes.map((column, index) => `${setColumns[index]} = ?`).join(', ');
    await connection.query({ sql: `UPDATE ${tableName} SET ${setSql} WHERE ${whereSql}`, timeout: 8000 }, [...changes.map((column) => input.changes[column]), ...whereValues]);
    await connection.commit();
    return { success: true as const, affectedRows: 1 };
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally { connection.release(); }
}
