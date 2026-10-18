import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSession } from './connection-service.js';
import { executeAddColumn, executeCreateTable, generateCreateTableSql, parseAddColumnSql, previewAddColumn, previewCreateTable, SchemaOperationError, validateCreateTableDraft, type CreateTableDraft } from './schema-service.js';

const base: CreateTableDraft = {
  schema: 'public', table: 'people', columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true },
    { name: 'display_name', type: 'varchar', length: 120, nullable: false, primaryKey: false },
  ],
};

test('generates engine-specific quoted CREATE TABLE statements', () => {
  const postgres = generateCreateTableSql(base, 'postgres');
  assert.match(postgres, /CREATE TABLE "public"\."people"/);
  assert.match(postgres, /"display_name" VARCHAR\(120\) NOT NULL/);
  assert.match(postgres, /PRIMARY KEY \("id"\)/);
  const mysql = generateCreateTableSql(base, 'mysql');
  assert.match(mysql, /CREATE TABLE `public`\.`people`/);
  assert.match(mysql, /`id` INTEGER NOT NULL/);
});

test('quotes embedded identifier delimiters in generated SQL', () => {
  const draft = { ...base, table: 'peo"ple', schema: 'pub`lic' };
  assert.match(generateCreateTableSql(draft, 'postgres'), /"peo""ple"/);
  assert.match(generateCreateTableSql(draft, 'mysql'), /`pub``lic`/);
});

test('rejects invalid identifiers, duplicate columns, nullable keys, and invalid bounds', () => {
  assert.throws(() => validateCreateTableDraft({ ...base, table: '' }, 'postgres'), SchemaOperationError);
  assert.throws(() => validateCreateTableDraft({ ...base, columns: [base.columns[0]!, { ...base.columns[1]!, name: 'ID' }] }, 'postgres'), /duplicated/);
  assert.throws(() => validateCreateTableDraft({ ...base, columns: [{ ...base.columns[0]!, nullable: true }] }, 'mysql'), /cannot be nullable/);
  assert.throws(() => validateCreateTableDraft({ ...base, columns: [{ ...base.columns[1]!, length: 256 }] }, 'postgres'), /VARCHAR length/);
  assert.throws(() => validateCreateTableDraft({ ...base, columns: [{ name: 'amount', type: 'decimal', nullable: true, primaryKey: false, precision: 4, scale: 5 }] }, 'mysql'), /DECIMAL precision/);
});

function fakePostgresSession() {
  const executed: string[] = [];
  const pool = {
    query: async (sql: string) => ({ rows: sql.includes('information_schema.schemata') ? [{ exists: true, can_create: true }] : [{ exists: false }] }),
    connect: async () => ({ query: async (sql: string) => { executed.push(sql); return { rows: [] }; }, release: () => undefined }),
  };
  return { session: { engine: 'postgres', database: 'sample', pool } as unknown as DatabaseSession, executed };
}

test('previews are connection-bound and one-use', async () => {
  const { session, executed } = fakePostgresSession();
  const plan = await previewCreateTable(session, 'a'.repeat(64), base);
  assert.equal(plan.expiresInSeconds, 300);
  await assert.rejects(executeCreateTable(session, 'b'.repeat(64), plan.planId), /different database session/);
  await executeCreateTable(session, 'a'.repeat(64), plan.planId);
  assert.ok(executed.includes(plan.sql));
  await assert.rejects(executeCreateTable(session, 'a'.repeat(64), plan.planId), /expired/);
});

test('MySQL plans are restricted to the connected database and execute generated SQL', async () => {
  const calls: string[] = [];
  const pool = { query: async (sql: string | { sql: string }) => {
    const statement = typeof sql === 'string' ? sql : sql.sql;
    calls.push(statement);
    return [[], []];
  } };
  const session = { engine: 'mysql', database: 'sample', pool } as unknown as DatabaseSession;
  await assert.rejects(previewCreateTable(session, 'c'.repeat(64), { ...base, schema: 'other' }), /limited to the connected database/);
  const plan = await previewCreateTable(session, 'c'.repeat(64), { ...base, schema: 'sample' });
  await executeCreateTable(session, 'c'.repeat(64), plan.planId);
  assert.ok(calls.includes(plan.sql));
  assert.match(plan.sql, /CREATE TABLE `sample`\.`people`/);
});

test('parses only one safe ALTER TABLE ADD COLUMN operation for each engine', () => {
  const pg = parseAddColumnSql('ALTER TABLE public.accounts ADD COLUMN "display_name" VARCHAR(80) NOT NULL;', 'postgres');
  assert.deepEqual(pg, { schema: 'public', table: 'accounts', columnName: 'display_name', sql: 'ALTER TABLE "public"."accounts" ADD COLUMN "display_name" VARCHAR(80) NOT NULL;' });
  const mysql = parseAddColumnSql('ALTER TABLE `sample`.`accounts` ADD COLUMN created_at TIMESTAMP NULL;', 'mysql');
  assert.match(mysql.sql, /ALTER TABLE `sample`\.`accounts` ADD COLUMN `created_at` TIMESTAMP;/);
  assert.throws(() => parseAddColumnSql('DROP TABLE public.accounts', 'postgres'), /ALTER TABLE/);
  assert.throws(() => parseAddColumnSql('ALTER TABLE public.accounts ADD COLUMN x INTEGER; DROP TABLE public.accounts', 'postgres'), /one statement/);
  assert.throws(() => parseAddColumnSql('ALTER TABLE public.accounts ADD COLUMN x TEXT DEFAULT \'secret\'', 'postgres'), /quoted/);
  assert.throws(() => parseAddColumnSql('ALTER TABLE public.accounts DROP COLUMN x', 'postgres'), /ADD/);
});

test('manual add-column plans recheck the target and execute only normalized SQL', async () => {
  const executed: string[] = [];
  const pool = {
    query: async (sql: string) => ({ rows: sql.includes('information_schema.tables') ? [{ exists: true }] : [{ exists: false }] }),
    connect: async () => ({ query: async (sql: string) => { executed.push(sql); return { rows: [] }; }, release: () => undefined }),
  };
  const session = { engine: 'postgres', database: 'sample', pool } as unknown as DatabaseSession;
  const plan = await previewAddColumn(session, 'd'.repeat(64), 'ALTER TABLE public.accounts ADD COLUMN note TEXT');
  await executeAddColumn(session, 'd'.repeat(64), plan.planId);
  assert.equal(executed[1], 'ALTER TABLE "public"."accounts" ADD COLUMN "note" TEXT;');
  assert.ok(executed.includes('COMMIT'));
  await assert.rejects(executeAddColumn(session, 'd'.repeat(64), plan.planId), /expired/);
});

test('MySQL add-column plans execute with a bounded timeout', async () => {
  const calls: Array<string | { sql: string; timeout?: number }> = [];
  const pool = { query: async (input: string | { sql: string; timeout?: number }) => {
    calls.push(input);
    const sql = typeof input === 'string' ? input : input.sql;
    if (sql.includes('information_schema.tables')) return [[{ TABLE_NAME: 'accounts' }], []];
    if (sql.includes('information_schema.columns')) return [[], []];
    return [[], []];
  } };
  const session = { engine: 'mysql', database: 'sample', pool } as unknown as DatabaseSession;
  const plan = await previewAddColumn(session, 'e'.repeat(64), 'ALTER TABLE `sample`.`accounts` ADD COLUMN nickname VARCHAR(40)');
  await executeAddColumn(session, 'e'.repeat(64), plan.planId);
  const executed = calls.at(-1);
  assert.deepEqual(executed, { sql: plan.sql, timeout: 8_000 });
});
