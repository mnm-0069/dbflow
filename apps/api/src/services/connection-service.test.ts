import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleMysqlSchema,
  assemblePostgresSchema,
  buildMysqlPageQuery,
  buildPostgresPageQuery,
  executeDatabaseQuery,
  readDatabaseTablePage,
  RecordSortColumnError,
  ReadOnlyQueryValidationError,
  validateReadOnlyQuery,
} from './connection-service.js';

const column = (table_name: string, column_name: string, data_type: string, extras: Partial<{
  udt_schema: string; udt_name: string; character_maximum_length: number | null;
  numeric_precision: number | null; numeric_scale: number | null;
  is_generated: string; is_nullable: string;
}> = {}) => ({
  table_schema: 'public', table_name, column_name, data_type,
  udt_schema: 'pg_catalog', udt_name: data_type,
  character_maximum_length: null, numeric_precision: null, numeric_scale: null,
  ...extras,
});

test('assembles PostgreSQL tables with readable types, primary keys, and foreign keys', () => {
  const tables = assemblePostgresSchema(
    [
      column('users', 'id', 'uuid'),
      column('users', 'name', 'character varying', { character_maximum_length: 120 }),
      column('orders', 'id', 'uuid'),
      column('orders', 'user_id', 'uuid'),
      column('orders', 'total', 'numeric', { numeric_precision: 10, numeric_scale: 2 }),
      column('orders', 'labels', 'ARRAY', { udt_schema: 'pg_catalog', udt_name: '_text' }),
      column('orders', 'state', 'USER-DEFINED', { udt_schema: 'public', udt_name: 'order_state' }),
      column('memberships', 'user_id', 'uuid'),
    ],
    [
      { table_schema: 'public', table_name: 'users', column_name: 'id' },
      { table_schema: 'public', table_name: 'orders', column_name: 'id' },
      { table_schema: 'public', table_name: 'memberships', column_name: 'user_id' },
    ],
    [{
      table_schema: 'public', table_name: 'orders', column_name: 'user_id',
      referenced_schema: 'public', referenced_table: 'users', referenced_column: 'id',
    }, {
      table_schema: 'public', table_name: 'memberships', column_name: 'user_id',
      referenced_schema: 'public', referenced_table: 'users', referenced_column: 'id',
    }],
  );

  assert.deepEqual(tables, [
    {
      schema: 'public', name: 'users',
      columns: [{ name: 'id', type: 'uuid', key: 'pk' }, { name: 'name', type: 'varchar(120)' }],
      foreignKeys: [],
    },
    {
      schema: 'public', name: 'orders',
      columns: [
        { name: 'id', type: 'uuid', key: 'pk' },
        { name: 'user_id', type: 'uuid', key: 'fk' },
        { name: 'total', type: 'numeric(10,2)' },
        { name: 'labels', type: 'text[]' },
        { name: 'state', type: 'public.order_state' },
      ],
      foreignKeys: [{ column: 'user_id', referencedSchema: 'public', referencedTable: 'users', referencedColumn: 'id' }],
    },
    {
      schema: 'public', name: 'memberships',
      columns: [{ name: 'user_id', type: 'uuid', key: 'pk-fk' }],
      foreignKeys: [{ column: 'user_id', referencedSchema: 'public', referencedTable: 'users', referencedColumn: 'id' }],
    },
  ]);
});

test('keeps introspection results empty when the account can see no tables', () => {
  assert.deepEqual(assemblePostgresSchema([], [], []), []);
});

test('marks generated and nullable PostgreSQL columns for safe row editing', () => {
  const [table] = assemblePostgresSchema([
    column('entries', 'id', 'integer', { is_generated: 'ALWAYS', is_nullable: 'NO' }),
    column('entries', 'label', 'text', { is_generated: 'NEVER', is_nullable: 'YES' }),
  ], [], []);
  assert.deepEqual(table?.columns, [
    { name: 'id', type: 'integer', generated: true, nullable: false },
    { name: 'label', type: 'text', nullable: true },
  ]);
});

test('quotes PostgreSQL identifiers and parameterizes the bounded page values', () => {
  const query = buildPostgresPageQuery('sales', 'orders"archive', 2, 25);
  assert.equal(query.text, 'SELECT * FROM "sales"."orders""archive" LIMIT $1 OFFSET $2');
  assert.deepEqual(query.values, [26, 50]);
});

test('sorts PostgreSQL pages by a visible field and uses primary keys as stable tie-breakers', () => {
  const query = buildPostgresPageQuery('sales', 'orders', 2, 25, { column: 'total', direction: 'desc' }, ['created_at', 'id']);
  assert.equal(query.text, 'SELECT * FROM "sales"."orders" ORDER BY "total" DESC, "created_at" ASC, "id" ASC LIMIT $1 OFFSET $2');
  assert.deepEqual(query.values, [26, 50]);
});

test('quotes MySQL sort identifiers and keeps pagination values parameterized', () => {
  const query = buildMysqlPageQuery('shop', 'orders', 1, 10, { column: 'total`amount', direction: 'asc' }, ['order_id']);
  assert.equal(query.text, 'SELECT * FROM `shop`.`orders` ORDER BY `total``amount` ASC, `order_id` ASC LIMIT ? OFFSET ?');
  assert.deepEqual(query.values, [11, 10]);
});

test('validates PostgreSQL sort columns against visible metadata before querying sorted rows', async () => {
  const queries: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        queries.push(sql);
        if (sql.includes('information_schema.tables')) return { rows: [{ table_name: 'orders', column_name: 'id' }] };
        if (sql.includes('information_schema.columns')) return { rows: values?.[2] === 'total' ? [{ column_name: 'total' }] : [] };
        return { rows: [{ id: 1, total: 5 }] };
      },
      release: () => undefined,
    }),
  };
  const session = { engine: 'postgres', database: 'shop', lastUsedAt: Date.now(), pool } as unknown as Parameters<typeof readDatabaseTablePage>[0];

  const page = await readDatabaseTablePage(session, 'public', 'orders', 0, 25, { column: 'total', direction: 'asc' });
  assert.deepEqual(page.rows, [{ id: 1, total: 5 }]);
  assert.match(queries.at(-1)!, /ORDER BY "total" ASC, "id" ASC LIMIT \$1 OFFSET \$2/);
  await assert.rejects(readDatabaseTablePage(session, 'public', 'orders', 0, 25, { column: 'missing', direction: 'asc' }), RecordSortColumnError);
});

test('rejects pagination outside the bounded range', () => {
  assert.throws(() => buildPostgresPageQuery('public', 'orders', -1, 25), RangeError);
  assert.throws(() => buildPostgresPageQuery('public', 'orders', 0, 101), RangeError);
});

test('assembles MySQL tables with declared types, primary keys, and foreign keys', () => {
  const tables = assembleMysqlSchema([
    { table_schema: 'shop', table_name: 'customers', column_name: 'id', column_type: 'bigint unsigned' },
    { table_schema: 'shop', table_name: 'orders', column_name: 'id', column_type: 'int' },
    { table_schema: 'shop', table_name: 'orders', column_name: 'customer_id', column_type: 'bigint unsigned' },
    { table_schema: 'shop', table_name: 'orders', column_name: 'total', column_type: 'decimal(10,2)' },
  ], [
    { table_schema: 'shop', table_name: 'customers', column_name: 'id' },
    { table_schema: 'shop', table_name: 'orders', column_name: 'id' },
  ], [{
    table_schema: 'shop', table_name: 'orders', column_name: 'customer_id',
    referenced_schema: 'shop', referenced_table: 'customers', referenced_column: 'id',
  }]);

  assert.deepEqual(tables, [
    { schema: 'shop', name: 'customers', columns: [{ name: 'id', type: 'bigint unsigned', key: 'pk' }], foreignKeys: [] },
    {
      schema: 'shop', name: 'orders',
      columns: [
        { name: 'id', type: 'int', key: 'pk' },
        { name: 'customer_id', type: 'bigint unsigned', key: 'fk' },
        { name: 'total', type: 'decimal(10,2)' },
      ],
      foreignKeys: [{ column: 'customer_id', referencedSchema: 'shop', referencedTable: 'customers', referencedColumn: 'id' }],
    },
  ]);
});

test('marks generated and nullable MySQL columns for safe row editing', () => {
  const tables = assembleMysqlSchema([
    { table_schema: 'shop', table_name: 'counters', column_name: 'total', column_type: 'int', is_generated: 'ALWAYS', is_nullable: 'NO' },
    { table_schema: 'shop', table_name: 'counters', column_name: 'note', column_type: 'text', is_generated: 'NEVER', is_nullable: 'YES' },
  ], [], []);
  assert.deepEqual(tables[0]?.columns, [
    { name: 'total', type: 'int', generated: true, nullable: false },
    { name: 'note', type: 'text', nullable: true },
  ]);
});

test('quotes MySQL identifiers and parameterizes bounded page values', () => {
  const query = buildMysqlPageQuery('shop', 'orders`archive', 2, 25);
  assert.equal(query.text, 'SELECT * FROM `shop`.`orders``archive` LIMIT ? OFFSET ?');
  assert.deepEqual(query.values, [26, 50]);
  assert.throws(() => buildMysqlPageQuery('shop', 'orders', 0, 101), RangeError);
});

test('accepts one read-only SELECT and ignores keywords inside strings and comments', () => {
  assert.equal(
    validateReadOnlyQuery("SELECT 'drop; update', \"create\" FROM orders -- delete\n; /* trailing */", 'postgres'),
    "SELECT 'drop; update', \"create\" FROM orders -- delete",
  );
  assert.equal(validateReadOnlyQuery('SELECT 5 # 3', 'postgres'), 'SELECT 5 # 3');
});

test('rejects data-changing, locking, file-output, and multi-statement SQL', () => {
  for (const query of [
    'INSERT INTO users VALUES (1)',
    'WITH removed AS (DELETE FROM users RETURNING id) SELECT * FROM removed',
    'SELECT * FROM users FOR UPDATE',
    'SELECT * FROM orders INTO OUTFILE \'/tmp/results.csv\'',
    'SELECT 1; DROP TABLE users',
    'SELECT @current_user := 1',
    "SELECT nextval('orders_id_seq')",
    "SELECT GET_LOCK('report', 1)",
    'SELECT LAST_INSERT_ID(17)',
    "SELECT pg_advisory_lock_shared(8)",
  ]) {
    assert.throws(() => validateReadOnlyQuery(query, 'mysql'), ReadOnlyQueryValidationError, query);
  }
});

test('runs bounded PostgreSQL reads inside a read-only transaction', async () => {
  const statements: string[] = [];
  const fakeRows = Array.from({ length: 1001 }, (_, id) => ({ id }));
  const session = {
    engine: 'postgres', database: 'shop', lastUsedAt: Date.now(),
    pool: {
      connect: async () => ({
        query: async (query: string) => {
          statements.push(query);
          if (query.startsWith('SELECT * FROM (')) return { fields: [{ name: 'id' }], rows: fakeRows };
          return { fields: [], rows: [] };
        },
        release: () => undefined,
      }),
    },
  } as unknown as Parameters<typeof executeDatabaseQuery>[0];

  const result = await executeDatabaseQuery(session, 'SELECT id FROM orders;');
  assert.equal(statements[0], 'BEGIN READ ONLY');
  assert.match(statements[1], /LIMIT 1001$/);
  assert.equal(statements[2], 'ROLLBACK');
  assert.deepEqual(result.columns, ['id']);
  assert.equal(result.rows.length, 1000);
  assert.equal(result.rowCount, 1000);
  assert.equal(result.truncated, true);
});

test('runs bounded MySQL reads inside a read-only transaction', async () => {
  const statements: string[] = [];
  const session = {
    engine: 'mysql', database: 'shop', lastUsedAt: Date.now(),
    pool: {
      getConnection: async () => ({
        query: async (query: string | { sql: string }) => {
          const text = typeof query === 'string' ? query : query.sql;
          statements.push(text);
          if (text.startsWith('SELECT * FROM (')) return [[{ id: 1 }], [{ name: 'id' }]];
          return [[], []];
        },
        rollback: async () => { statements.push('ROLLBACK'); },
        release: () => { statements.push('RELEASE'); },
      }),
    },
  } as unknown as Parameters<typeof executeDatabaseQuery>[0];

  const result = await executeDatabaseQuery(session, 'SELECT id FROM orders');
  assert.equal(statements[0], 'START TRANSACTION READ ONLY');
  assert.match(statements[1], /LIMIT 1001$/);
  assert.equal(statements[2], 'ROLLBACK');
  assert.equal(statements[3], 'RELEASE');
  assert.deepEqual(result.columns, ['id']);
  assert.deepEqual(result.rows, [{ id: 1 }]);
  assert.equal(result.truncated, false);
});
