import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSession } from './connection-service.js';
import { RecordUpdateError, updateDatabaseRecord } from './record-update-service.js';

const input = { schema: 'public', table: 'people', primaryKey: { id: 7 }, originalValues: { name: 'Ada' }, changes: { name: 'Ada Lovelace' } };

function fakePostgres(rowCount = 1) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('UPDATE')) { statements.push({ sql, values }); return { rowCount, rows: rowCount ? [{ '?column?': 1 }] : [] }; }
      if (sql.includes('information_schema.tables')) return { rows: [{ exists: true }] };
      if (sql.includes('table_constraints')) return { rows: [{ column_name: 'id' }] };
      return { rows: [{ column_name: 'id', is_generated: 'NEVER' }, { column_name: 'name', is_generated: 'NEVER' }] };
    },
  };
  return { session: { engine: 'postgres', database: 'sample', pool } as unknown as DatabaseSession, statements };
}

test('updates one PostgreSQL row by its complete primary key and original value', async () => {
  const { session, statements } = fakePostgres();
  const result = await updateDatabaseRecord(session, input);
  assert.deepEqual(result, { success: true, affectedRows: 1 });
  const update = statements[0]!;
  assert.match(update.sql, /UPDATE "public"\."people" SET "name" = \$1 WHERE "id" = \$2 AND "name" IS NOT DISTINCT FROM \$3 RETURNING 1/);
  assert.deepEqual(update.values, ['Ada Lovelace', 7, 'Ada']);
});

test('rejects missing primary keys, edits to key/generated columns, and stale rows', async () => {
  const { session } = fakePostgres();
  await assert.rejects(updateDatabaseRecord(session, { ...input, primaryKey: {} }), /primary key/);
  await assert.rejects(updateDatabaseRecord(session, { ...input, changes: { id: 8 }, originalValues: { id: 7 } }), /Primary-key columns/);
  await assert.rejects(updateDatabaseRecord(session, { ...input, changes: { unknown: 'x' }, originalValues: { unknown: null } }), /not visible/);
  const stale = fakePostgres(0);
  await assert.rejects(updateDatabaseRecord(stale.session, input), (error: unknown) => error instanceof RecordUpdateError && error.status === 409);
});

test('MySQL updates use a locked primary-key match and null-safe optimistic comparison', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('information_schema.tables')) return [[{ TABLE_NAME: 'people' }], []];
      if (sql.includes('key_column_usage')) return [[{ column_name: 'id' }], []];
      return [[{ column_name: 'id', is_generated: 'NEVER' }, { column_name: 'name', is_generated: 'NEVER' }], []];
    },
    getConnection: async () => ({
      beginTransaction: async () => undefined,
      query: async (query: string | { sql: string; timeout?: number }, values?: unknown[]) => {
        const sql = typeof query === 'string' ? query : query.sql;
        calls.push({ sql, values });
        return sql.startsWith('SELECT') ? [[{ 1: 1 }], []] : [{ affectedRows: 1 }, []];
      },
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    }),
  };
  const session = { engine: 'mysql', database: 'shop', pool } as unknown as DatabaseSession;
  const result = await updateDatabaseRecord(session, { ...input, schema: 'shop' });
  assert.deepEqual(result, { success: true, affectedRows: 1 });
  assert.match(calls[0]!.sql, /`id` = \? AND `name` <=> \?/);
  assert.match(calls[1]!.sql, /UPDATE `shop`\.`people` SET `name` = \? WHERE `id` = \? AND `name` <=> \?/);
  assert.deepEqual(calls[1]!.values, ['Ada Lovelace', 7, 'Ada']);
});
