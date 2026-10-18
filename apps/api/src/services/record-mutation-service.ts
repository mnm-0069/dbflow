import { randomBytes } from 'node:crypto';
import type { DatabaseSession } from './connection-service.js';

const PLAN_TTL_MS = 5 * 60_000;
const MAX_PLANS = 100;
const MAX_COLUMNS = 250;

export class RecordMutationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type ColumnInfo = { name: string; nullable: boolean; hasDefault: boolean; generated: boolean; identity: boolean };
type TableInfo = { columns: ColumnInfo[]; primaryKeys: string[] };
type InsertInput = { schema: string; table: string; values: Record<string, unknown> };
type DeleteInput = { schema: string; table: string; primaryKey: Record<string, unknown>; originalValues: Record<string, unknown> };
type MutationPlan = {
  connectionId: string; engine: DatabaseSession['engine']; schema: string; table: string;
  action: 'insert' | 'delete'; expiresAt: number; metadataSignature: string;
  values?: Record<string, unknown>; primaryKey?: Record<string, unknown>; originalValues?: Record<string, unknown>;
};
const plans = new Map<string, MutationPlan>();

function quote(value: string, engine: DatabaseSession['engine']) {
  return engine === 'postgres' ? `"${value.replaceAll('"', '""')}"` : `\`${value.replaceAll('`', '``')}\``;
}

function assertScalar(value: unknown, label: string) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 100_000)) return;
  throw new RecordMutationError(`${label} must be a string, finite number, boolean, or NULL.`);
}

function validateNames(values: Record<string, unknown>, label: string, maximum = 50) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > maximum) {
    throw new RecordMutationError(`${label} must contain no more than ${maximum} fields.`);
  }
  for (const [name, value] of Object.entries(values)) {
    if (!name.trim() || name.length > 128) throw new RecordMutationError(`${label} contains an invalid column name.`);
    assertScalar(value, `Value for “${name}”`);
  }
}

async function tableInfo(session: DatabaseSession, schema: string, table: string): Promise<TableInfo> {
  if (!schema.trim() || !table.trim()) throw new RecordMutationError('Choose a schema and table.');
  if (session.engine === 'postgres') {
    if (['information_schema', 'pg_catalog'].includes(schema) || schema.startsWith('pg_')) throw new RecordMutationError('System schemas cannot be changed.', 403);
    const tableResult = await session.pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE') AS exists", [schema, table],
    );
    if (!tableResult.rows[0]?.exists) throw new RecordMutationError('That base table is not visible in this database session.', 404);
    const [columns, keys] = await Promise.all([
      session.pool.query<{ column_name: string; is_nullable: string; has_default: boolean; is_generated: string; is_identity: string }>(
        'SELECT column_name, is_nullable, column_default IS NOT NULL AS has_default, is_generated, is_identity FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position', [schema, table],
      ),
      session.pool.query<{ column_name: string }>(`
        SELECT kcu.column_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_catalog = kcu.constraint_catalog
          AND tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
        ORDER BY kcu.ordinal_position
      `, [schema, table]),
    ]);
    return {
      columns: columns.rows.map((column) => ({ name: column.column_name, nullable: column.is_nullable === 'YES', hasDefault: column.has_default, generated: column.is_generated !== 'NEVER', identity: column.is_identity === 'YES' })),
      primaryKeys: keys.rows.map((row) => row.column_name),
    };
  }
  if (schema !== session.database) throw new RecordMutationError('MySQL record changes are limited to the connected database.', 400);
  const [tableRows] = await session.pool.query("SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'", [schema, table]);
  if (!(tableRows as unknown[]).length) throw new RecordMutationError('That base table is not visible in this database session.', 404);
  const [columnQuery, keyQuery] = await Promise.all([
    session.pool.query('SELECT COLUMN_NAME AS column_name, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, IS_GENERATED AS is_generated, EXTRA AS extra FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [schema, table]),
    session.pool.query("SELECT COLUMN_NAME AS column_name FROM information_schema.key_column_usage WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION", [schema, table]),
  ]);
  const columnRows = columnQuery[0] as Array<{ column_name: string; is_nullable: string; column_default: unknown; is_generated: string; extra: string }>;
  const keyRows = keyQuery[0] as Array<{ column_name: string }>;
  return {
    columns: columnRows.map((column) => ({ name: column.column_name, nullable: column.is_nullable === 'YES', hasDefault: column.column_default !== null, generated: column.is_generated !== 'NEVER', identity: /auto_increment/i.test(column.extra ?? '') })),
    primaryKeys: keyRows.map((row) => row.column_name),
  };
}

function metadataSignature(info: TableInfo) {
  return JSON.stringify({ columns: info.columns, primaryKeys: info.primaryKeys });
}

function prunePlans() {
  const now = Date.now();
  for (const [id, plan] of plans) if (plan.expiresAt <= now) plans.delete(id);
  while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value!);
}

function createPlan(plan: Omit<MutationPlan, 'expiresAt'>) {
  prunePlans();
  const planId = randomBytes(32).toString('hex');
  plans.set(planId, { ...plan, expiresAt: Date.now() + PLAN_TTL_MS });
  return { planId, expiresInSeconds: PLAN_TTL_MS / 1000 };
}

function validateInsertValues(values: Record<string, unknown>, info: TableInfo) {
  validateNames(values, 'Inserted values');
  const columnsByName = new Map(info.columns.map((column) => [column.name, column]));
  for (const name of Object.keys(values)) {
    const column = columnsByName.get(name);
    if (!column) throw new RecordMutationError(`Column “${name}” is not visible on this table.`);
    if (column.generated || column.identity) throw new RecordMutationError(`Generated column “${name}” is set by the database and cannot be supplied.`);
  }
  const missingRequired = info.columns.find((column) => !column.nullable && !column.hasDefault && !column.generated && !column.identity && !Object.hasOwn(values, column.name));
  if (missingRequired) throw new RecordMutationError(`Provide a value for required column “${missingRequired.name}”.`);
}

export async function previewRecordInsert(session: DatabaseSession, connectionId: string, input: InsertInput) {
  const info = await tableInfo(session, input.schema, input.table);
  validateInsertValues(input.values, info);
  return createPlan({ connectionId, engine: session.engine, schema: input.schema, table: input.table, action: 'insert', metadataSignature: metadataSignature(info), values: input.values });
}

function snapshotWhere(engine: DatabaseSession['engine'], keys: string[], snapshotColumns: string[], primaryKey: Record<string, unknown>, originalValues: Record<string, unknown>) {
  const identifiers = [...keys.map((key) => [key, primaryKey[key]] as const), ...snapshotColumns.map((column) => [column, originalValues[column]] as const)];
  const clause = identifiers.map(([column], index) => engine === 'postgres'
    ? `${quote(column, engine)} IS NOT DISTINCT FROM $${index + 1}`
    : `${quote(column, engine)} <=> ?`).join(' AND ');
  return { clause, values: identifiers.map(([, value]) => value) };
}

async function assertDeleteSnapshot(session: DatabaseSession, schema: string, table: string, info: TableInfo, primaryKey: Record<string, unknown>, originalValues: Record<string, unknown>) {
  if (!info.primaryKeys.length) throw new RecordMutationError('Rows can only be deleted when the table has a primary key.', 409);
  if (info.primaryKeys.length > 10 || info.primaryKeys.some((key) => !Object.hasOwn(primaryKey, key)) || Object.keys(primaryKey).length !== info.primaryKeys.length) {
    throw new RecordMutationError('Provide every primary-key value for this table.');
  }
  validateNames(primaryKey, 'Primary key', 10);
  validateNames(originalValues, 'Row snapshot', MAX_COLUMNS);
  const visibleNames = new Set(info.columns.map((column) => column.name));
  if (!Object.keys(originalValues).length || Object.keys(originalValues).some((column) => !visibleNames.has(column))) {
    throw new RecordMutationError('Refresh the row before reviewing its deletion.');
  }
  for (const key of info.primaryKeys) {
    if (!Object.hasOwn(originalValues, key) || originalValues[key] !== primaryKey[key]) throw new RecordMutationError('The row key does not match the selected row snapshot.');
  }
  const where = snapshotWhere(session.engine, info.primaryKeys, Object.keys(originalValues).filter((column) => !info.primaryKeys.includes(column)), primaryKey, originalValues);
  const target = `${quote(schema, session.engine)}.${quote(table, session.engine)}`;
  if (session.engine === 'postgres') {
    const result = await session.pool.query(`SELECT 1 FROM ${target} WHERE ${where.clause} LIMIT 1`, where.values);
    if (!result.rowCount) throw new RecordMutationError('This row changed or was removed. Refresh the page before deleting it.', 409);
  } else {
    const [rows] = await session.pool.query(`SELECT 1 FROM ${target} WHERE ${where.clause} LIMIT 1`, where.values);
    if (!(rows as unknown[]).length) throw new RecordMutationError('This row changed or was removed. Refresh the page before deleting it.', 409);
  }
  return where;
}

export async function previewRecordDelete(session: DatabaseSession, connectionId: string, input: DeleteInput) {
  const info = await tableInfo(session, input.schema, input.table);
  await assertDeleteSnapshot(session, input.schema, input.table, info, input.primaryKey, input.originalValues);
  return createPlan({ connectionId, engine: session.engine, schema: input.schema, table: input.table, action: 'delete', metadataSignature: metadataSignature(info), primaryKey: input.primaryKey, originalValues: input.originalValues });
}

function getPlan(session: DatabaseSession, connectionId: string, planId: string, action: MutationPlan['action']) {
  const plan = plans.get(planId);
  if (!plan || plan.expiresAt <= Date.now()) { plans.delete(planId); throw new RecordMutationError('This review expired. Review the row change again before continuing.', 409); }
  if (plan.connectionId !== connectionId || plan.engine !== session.engine || plan.action !== action) throw new RecordMutationError('This review belongs to a different operation or database session.', 409);
  plans.delete(planId);
  return plan;
}

export async function executeRecordInsert(session: DatabaseSession, connectionId: string, planId: string) {
  const plan = getPlan(session, connectionId, planId, 'insert');
  const info = await tableInfo(session, plan.schema, plan.table);
  if (metadataSignature(info) !== plan.metadataSignature) throw new RecordMutationError('The table changed after review. Create a new insert review.', 409);
  const values = plan.values ?? {};
  validateInsertValues(values, info);
  const columns = Object.keys(values);
  const target = `${quote(plan.schema, session.engine)}.${quote(plan.table, session.engine)}`;
  if (session.engine === 'postgres') {
    const sql = columns.length ? `INSERT INTO ${target} (${columns.map((column) => quote(column, session.engine)).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})` : `INSERT INTO ${target} DEFAULT VALUES`;
    await session.pool.query(sql, columns.map((column) => values[column]));
  } else {
    const sql = columns.length ? `INSERT INTO ${target} (${columns.map((column) => quote(column, session.engine)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})` : `INSERT INTO ${target} () VALUES ()`;
    await session.pool.query({ sql, timeout: 8_000 }, columns.map((column) => values[column]));
  }
  return { success: true as const, affectedRows: 1 };
}

export async function executeRecordDelete(session: DatabaseSession, connectionId: string, planId: string) {
  const plan = getPlan(session, connectionId, planId, 'delete');
  const info = await tableInfo(session, plan.schema, plan.table);
  if (metadataSignature(info) !== plan.metadataSignature) throw new RecordMutationError('The table changed after review. Review the deletion again.', 409);
  const primaryKey = plan.primaryKey ?? {};
  const originalValues = plan.originalValues ?? {};
  const where = await assertDeleteSnapshot(session, plan.schema, plan.table, info, primaryKey, originalValues);
  const target = `${quote(plan.schema, session.engine)}.${quote(plan.table, session.engine)}`;
  if (session.engine === 'postgres') {
    const result = await session.pool.query(`DELETE FROM ${target} WHERE ${where.clause} RETURNING 1`, where.values);
    if (result.rowCount !== 1) throw new RecordMutationError('This row changed or was removed. Refresh the page before deleting it.', 409);
  } else {
    const connection = await session.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [matches] = await connection.query(`SELECT 1 FROM ${target} WHERE ${where.clause} LIMIT 1 FOR UPDATE`, where.values);
      if (!(matches as unknown[]).length) throw new RecordMutationError('This row changed or was removed. Refresh the page before deleting it.', 409);
      const keys = info.primaryKeys;
      const keyClause = keys.map((key) => `${quote(key, session.engine)} = ?`).join(' AND ');
      await connection.query({ sql: `DELETE FROM ${target} WHERE ${keyClause}`, timeout: 8_000 }, keys.map((key) => primaryKey[key]));
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
  return { success: true as const, affectedRows: 1 };
}
