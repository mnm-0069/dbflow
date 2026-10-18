import { randomBytes } from 'node:crypto';
import type { DatabaseSession } from './connection-service.js';

export type CreateTableColumnType = 'integer' | 'bigint' | 'varchar' | 'text' | 'boolean' | 'timestamp' | 'decimal';
export type CreateTableColumnDraft = {
  name: string;
  type: CreateTableColumnType;
  nullable: boolean;
  primaryKey: boolean;
  length?: number;
  precision?: number;
  scale?: number;
};
export type CreateTableDraft = { schema: string; table: string; columns: CreateTableColumnDraft[] };
export type CreateTablePlan = { planId: string; sql: string; expiresInSeconds: number };

export class SchemaOperationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const PLAN_TTL_MS = 5 * 60_000;
const MAX_PLANS = 100;
type SchemaPlan = { connectionId: string; engine: DatabaseSession['engine']; sql: string; schema: string; table: string; expiresAt: number; action: 'create-table' | 'add-column'; columnName?: string };
const plans = new Map<string, SchemaPlan>();

function validateIdentifier(value: string, label: string, engine: DatabaseSession['engine']) {
  const normalized = value.trim();
  const maxBytes = engine === 'postgres' ? 63 : 64;
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SchemaOperationError(`${label} must be 1–${maxBytes} bytes and cannot contain control characters.`);
  }
  return normalized;
}

export function validateCreateTableDraft(input: CreateTableDraft, engine: DatabaseSession['engine']): CreateTableDraft {
  if (!input || typeof input !== 'object') throw new SchemaOperationError('Provide a table definition.');
  const schema = validateIdentifier(input.schema, 'Schema name', engine);
  const table = validateIdentifier(input.table, 'Table name', engine);
  if (!Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > 50) {
    throw new SchemaOperationError('A table must have between 1 and 50 columns.');
  }
  const names = new Set<string>();
  const columns = input.columns.map((column) => {
    if (!column || typeof column !== 'object') throw new SchemaOperationError('Each column needs a definition.');
    const name = validateIdentifier(column.name, 'Column name', engine);
    const normalizedName = name.toLocaleLowerCase('en-US');
    if (names.has(normalizedName)) throw new SchemaOperationError(`Column “${name}” is duplicated.`);
    names.add(normalizedName);
    if (!['integer', 'bigint', 'varchar', 'text', 'boolean', 'timestamp', 'decimal'].includes(column.type)) {
      throw new SchemaOperationError(`Column “${name}” has an unsupported type.`);
    }
    if (typeof column.nullable !== 'boolean' || typeof column.primaryKey !== 'boolean') {
      throw new SchemaOperationError(`Column “${name}” needs explicit nullability and primary-key settings.`);
    }
    if (column.primaryKey && column.nullable) throw new SchemaOperationError(`Primary key column “${name}” cannot be nullable.`);
    if (column.type === 'varchar' && (!Number.isInteger(column.length) || column.length! < 1 || column.length! > 255)) {
      throw new SchemaOperationError(`Column “${name}” needs a VARCHAR length from 1 to 255.`);
    }
    if (column.type === 'decimal' && (!Number.isInteger(column.precision) || column.precision! < 1 || column.precision! > 38 || !Number.isInteger(column.scale) || column.scale! < 0 || column.scale! > column.precision!)) {
      throw new SchemaOperationError(`Column “${name}” needs DECIMAL precision 1–38 and scale 0–precision.`);
    }
    return { name, type: column.type, nullable: column.nullable, primaryKey: column.primaryKey,
      ...(column.type === 'varchar' ? { length: column.length } : {}),
      ...(column.type === 'decimal' ? { precision: column.precision, scale: column.scale } : {}) };
  });
  return { schema, table, columns };
}

function quoteIdentifier(identifier: string, engine: DatabaseSession['engine']) {
  return engine === 'postgres' ? `"${identifier.replace(/"/g, '""')}"` : `\`${identifier.replace(/`/g, '``')}\``;
}

export function generateCreateTableSql(draft: CreateTableDraft, engine: DatabaseSession['engine']) {
  const tableName = `${quoteIdentifier(draft.schema, engine)}.${quoteIdentifier(draft.table, engine)}`;
  const definitions = draft.columns.map((column) => {
    const type = column.type === 'integer' ? 'INTEGER' : column.type === 'bigint' ? 'BIGINT' : column.type === 'varchar' ? `VARCHAR(${column.length})` : column.type === 'text' ? 'TEXT' : column.type === 'boolean' ? 'BOOLEAN' : column.type === 'timestamp' ? 'TIMESTAMP' : `DECIMAL(${column.precision}, ${column.scale})`;
    return `  ${quoteIdentifier(column.name, engine)} ${type}${column.nullable ? '' : ' NOT NULL'}`;
  });
  const primaryKey = draft.columns.filter((column) => column.primaryKey);
  if (primaryKey.length) definitions.push(`  PRIMARY KEY (${primaryKey.map((column) => quoteIdentifier(column.name, engine)).join(', ')})`);
  return `CREATE TABLE ${tableName} (\n${definitions.join(',\n')}\n);`;
}

async function assertTargetAvailable(session: DatabaseSession, schema: string, table: string) {
  if (session.engine === 'postgres') {
    const schemaResult = await session.pool.query<{ exists: boolean; can_create: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists, has_schema_privilege($1, \'CREATE\') AS can_create', [schema],
    );
    if (!schemaResult.rows[0]?.exists) throw new SchemaOperationError(`Schema “${schema}” does not exist.`, 422);
    if (!schemaResult.rows[0]?.can_create) throw new SchemaOperationError(`The current database user cannot create tables in schema “${schema}”.`, 403);
    const tableResult = await session.pool.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) AS exists', [schema, table],
    );
    if (tableResult.rows[0]?.exists) throw new SchemaOperationError(`Table “${schema}.${table}” already exists.`, 409);
    return;
  }
  if (schema !== session.database) throw new SchemaOperationError('MySQL table creation is limited to the connected database.', 400);
  const result = await session.pool.query('SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [schema, table]);
  if ((result[0] as unknown[]).length) throw new SchemaOperationError(`Table “${schema}.${table}” already exists.`, 409);
}

function prunePlans() {
  const now = Date.now();
  for (const [id, plan] of plans) if (plan.expiresAt <= now) plans.delete(id);
  while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value!);
}

export async function previewCreateTable(session: DatabaseSession, connectionId: string, input: CreateTableDraft): Promise<CreateTablePlan> {
  const draft = validateCreateTableDraft(input, session.engine);
  await assertTargetAvailable(session, draft.schema, draft.table);
  prunePlans();
  const planId = randomBytes(32).toString('hex');
  const sql = generateCreateTableSql(draft, session.engine);
  plans.set(planId, { connectionId, engine: session.engine, sql, schema: draft.schema, table: draft.table, expiresAt: Date.now() + PLAN_TTL_MS, action: 'create-table' });
  return { planId, sql, expiresInSeconds: PLAN_TTL_MS / 1000 };
}

type SqlToken = { kind: 'word' | 'identifier' | 'number' | 'punctuation'; value: string };
function tokenizeAddColumnSql(source: string, engine: DatabaseSession['engine']): SqlToken[] {
  if (typeof source !== 'string' || source.length < 1 || source.length > 5_000) throw new SchemaOperationError('Enter one ALTER TABLE statement under 5,000 characters.');
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) { index += 1; continue; }
    if (source.startsWith('--', index) || (engine === 'mysql' && char === '#')) {
      const end = source.indexOf('\n', index + (char === '#' ? 1 : 2)); index = end < 0 ? source.length : end + 1; continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new SchemaOperationError('The SQL contains an unfinished comment.');
      index = end + 2; continue;
    }
    const quote = engine === 'postgres' ? '"' : '`';
    if (char === quote) {
      index += 1; let value = '';
      while (index < source.length) {
        if (source[index] === quote) {
          if (source[index + 1] === quote) { value += quote; index += 2; continue; }
          index += 1; break;
        }
        value += source[index]!; index += 1;
      }
      if (source[index - 1] !== quote || !value) throw new SchemaOperationError('The SQL contains an invalid quoted identifier.');
      tokens.push({ kind: 'identifier', value }); continue;
    }
    if (char === "'" || char === '"' || char === '`') throw new SchemaOperationError('Only identifiers may be quoted in this schema-change statement.');
    const word = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
    if (word) { tokens.push({ kind: 'word', value: word }); index += word.length; continue; }
    const number = source.slice(index).match(/^\d+/)?.[0];
    if (number) { tokens.push({ kind: 'number', value: number }); index += number.length; continue; }
    if ('.(),;'.includes(char)) { tokens.push({ kind: 'punctuation', value: char }); index += 1; continue; }
    throw new SchemaOperationError('This ALTER TABLE statement contains unsupported syntax.');
  }
  if (tokens.at(-1)?.value === ';') tokens.pop();
  if (tokens.some((token) => token.value === ';')) throw new SchemaOperationError('Run one statement at a time.');
  return tokens;
}

export function parseAddColumnSql(source: string, engine: DatabaseSession['engine']) {
  const tokens = tokenizeAddColumnSql(source, engine);
  let index = 0;
  const readWord = (expected: string) => {
    const token = tokens[index++];
    if (token?.kind !== 'word' || token.value.toUpperCase() !== expected) throw new SchemaOperationError(`This workflow supports ALTER TABLE … ADD COLUMN only (expected ${expected}).`);
  };
  const readIdentifier = (label: string) => {
    const token = tokens[index++];
    if (token?.kind !== 'word' && token?.kind !== 'identifier') throw new SchemaOperationError(`Provide a ${label} identifier.`);
    return validateIdentifier(token.kind === 'word' && engine === 'postgres' ? token.value.toLowerCase() : token.value, label, engine);
  };
  const readNumber = (label: string) => {
    const token = tokens[index++];
    if (token?.kind !== 'number') throw new SchemaOperationError(`Provide a numeric ${label}.`);
    return Number(token.value);
  };
  readWord('ALTER'); readWord('TABLE');
  const schema = readIdentifier('schema');
  if (tokens[index++]?.value !== '.') throw new SchemaOperationError('Qualify the table as schema.table.');
  const table = readIdentifier('table');
  readWord('ADD');
  if (tokens[index]?.kind === 'word' && tokens[index]?.value.toUpperCase() === 'COLUMN') index += 1;
  const columnName = readIdentifier('column');
  const typeToken = tokens[index++];
  if (typeToken?.kind !== 'word') throw new SchemaOperationError('Use a supported column type: INTEGER, BIGINT, VARCHAR, TEXT, BOOLEAN, TIMESTAMP, or DECIMAL.');
  const typeName = typeToken.value.toUpperCase();
  let type: string;
  if (typeName === 'INTEGER' || typeName === 'INT') type = 'INTEGER';
  else if (typeName === 'BIGINT' || typeName === 'TEXT' || typeName === 'BOOLEAN' || typeName === 'TIMESTAMP') type = typeName;
  else if (typeName === 'VARCHAR') {
    if (tokens[index++]?.value !== '(') throw new SchemaOperationError('VARCHAR requires a length from 1 to 255.');
    const length = readNumber('VARCHAR length');
    if (tokens[index++]?.value !== ')' || length < 1 || length > 255) throw new SchemaOperationError('VARCHAR requires a length from 1 to 255.');
    type = `VARCHAR(${length})`;
  } else if (typeName === 'DECIMAL' || typeName === 'NUMERIC') {
    if (tokens[index++]?.value !== '(') throw new SchemaOperationError('DECIMAL requires precision and scale.');
    const precision = readNumber('DECIMAL precision');
    if (tokens[index++]?.value !== ',') throw new SchemaOperationError('DECIMAL requires precision and scale.');
    const scale = readNumber('DECIMAL scale');
    if (tokens[index++]?.value !== ')' || precision < 1 || precision > 38 || scale > precision) throw new SchemaOperationError('DECIMAL precision must be 1–38 and scale 0–precision.');
    type = `DECIMAL(${precision}, ${scale})`;
  } else throw new SchemaOperationError('This workflow supports INTEGER, BIGINT, VARCHAR, TEXT, BOOLEAN, TIMESTAMP, and DECIMAL columns.');
  let nullable = true;
  if (tokens[index]?.kind === 'word' && tokens[index]?.value.toUpperCase() === 'NOT') { index += 1; readWord('NULL'); nullable = false; }
  else if (tokens[index]?.kind === 'word' && tokens[index]?.value.toUpperCase() === 'NULL') index += 1;
  if (index !== tokens.length) throw new SchemaOperationError('Only a single ADD COLUMN clause with an optional NULL or NOT NULL modifier is supported.');
  const sql = `ALTER TABLE ${quoteIdentifier(schema, engine)}.${quoteIdentifier(table, engine)} ADD COLUMN ${quoteIdentifier(columnName, engine)} ${type}${nullable ? '' : ' NOT NULL'};`;
  return { schema, table, columnName, sql };
}

async function assertColumnCanBeAdded(session: DatabaseSession, schema: string, table: string, column: string) {
  if (session.engine === 'postgres') {
    const tableResult = await session.pool.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = \'BASE TABLE\') AS exists', [schema, table],
    );
    if (!tableResult.rows[0]?.exists) throw new SchemaOperationError(`Table “${schema}.${table}” does not exist or is not visible.`, 404);
    const columnResult = await session.pool.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3) AS exists', [schema, table, column],
    );
    if (columnResult.rows[0]?.exists) throw new SchemaOperationError(`Column “${column}” already exists on “${schema}.${table}”.`, 409);
    return;
  }
  if (schema !== session.database) throw new SchemaOperationError('MySQL table changes are limited to the connected database.', 400);
  const [tables] = await session.pool.query('SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = \'BASE TABLE\'', [schema, table]);
  if (!(tables as unknown[]).length) throw new SchemaOperationError(`Table “${schema}.${table}” does not exist or is not visible.`, 404);
  const [columns] = await session.pool.query('SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [schema, table, column]);
  if ((columns as unknown[]).length) throw new SchemaOperationError(`Column “${column}” already exists on “${schema}.${table}”.`, 409);
}

export async function previewAddColumn(session: DatabaseSession, connectionId: string, source: string): Promise<CreateTablePlan> {
  const parsed = parseAddColumnSql(source, session.engine);
  await assertColumnCanBeAdded(session, parsed.schema, parsed.table, parsed.columnName);
  prunePlans();
  const planId = randomBytes(32).toString('hex');
  plans.set(planId, { connectionId, engine: session.engine, sql: parsed.sql, schema: parsed.schema, table: parsed.table, columnName: parsed.columnName, expiresAt: Date.now() + PLAN_TTL_MS, action: 'add-column' });
  return { planId, sql: parsed.sql, expiresInSeconds: PLAN_TTL_MS / 1000 };
}

async function executePlan(session: DatabaseSession, connectionId: string, planId: string, expectedAction: SchemaPlan['action']) {
  const plan = plans.get(planId);
  if (!plan || plan.expiresAt <= Date.now()) { plans.delete(planId); throw new SchemaOperationError('This SQL preview expired. Generate a new preview before creating the table.', 409); }
  if (plan.connectionId !== connectionId || plan.engine !== session.engine) throw new SchemaOperationError('This SQL preview belongs to a different database session.', 409);
  if (plan.action !== expectedAction) throw new SchemaOperationError('This SQL preview is for a different schema operation.', 409);
  plans.delete(planId);
  if (plan.action === 'create-table') await assertTargetAvailable(session, plan.schema, plan.table);
  else await assertColumnCanBeAdded(session, plan.schema, plan.table, plan.columnName!);
  if (session.engine === 'postgres') {
    const client = await session.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(plan.sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  } else {
    await session.pool.query({ sql: plan.sql, timeout: 8_000 });
  }
  return { success: true as const, sql: plan.sql, database: session.database, schema: plan.schema, table: plan.table, ...(plan.columnName ? { column: plan.columnName } : {}) };
}

export async function executeCreateTable(session: DatabaseSession, connectionId: string, planId: string) {
  return executePlan(session, connectionId, planId, 'create-table');
}

export async function executeAddColumn(session: DatabaseSession, connectionId: string, planId: string) {
  return executePlan(session, connectionId, planId, 'add-column');
}
