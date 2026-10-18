import { Router } from 'express';
import { z } from 'zod';
import {
  closeDatabaseSession,
  DatabaseQueryResultSizeError,
  executeDatabaseQuery,
  getDatabaseSession,
  introspectDatabaseSchema,
  openDatabaseSession,
  PostgresResultSizeError,
  PostgresSessionLimitError,
  PostgresTableNotFoundError,
  readDatabaseTablePage,
  RecordSortColumnError,
  ReadOnlyQueryValidationError,
  testDatabaseConnection,
} from '../services/connection-service.js';
import { executeAddColumn, executeCreateTable, previewAddColumn, previewCreateTable, SchemaOperationError, type CreateTableColumnDraft } from '../services/schema-service.js';
import { DatabaseHostValidationError } from '../services/database-host.js';
import { RecordUpdateError, updateDatabaseRecord } from '../services/record-update-service.js';
import { executeRecordDelete, executeRecordInsert, previewRecordDelete, previewRecordInsert, RecordMutationError } from '../services/record-mutation-service.js';

export const connectionsRouter = Router();
const testConnectionSchema = z.object({
  engine: z.enum(['postgres', 'mysql']),
  host: z.string().trim().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(128),
  username: z.string().min(1).max(128),
  password: z.string().max(1024),
  ssl: z.boolean().default(false),
}).strict();

connectionsRouter.post('/open', async (req, res, next) => {
  const parsed = testConnectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid connection details', details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const result = await openDatabaseSession(parsed.data);
    res.json(result);
  } catch (error) {
    if (error instanceof PostgresSessionLimitError) {
      res.status(429).json({ error: 'The local API already has the maximum number of active database sessions. Disconnect one and retry.' });
      return;
    }
    if (error instanceof DatabaseHostValidationError) { res.status(400).json({ error: error.message }); return; }
    next(error);
  }
});

const sessionSchema = z.object({ connectionId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const createTableColumnSchema = z.object({
  name: z.string().max(128),
  type: z.enum(['integer', 'bigint', 'varchar', 'text', 'boolean', 'timestamp', 'decimal']),
  nullable: z.boolean(),
  primaryKey: z.boolean(),
  length: z.number().int().optional(),
  precision: z.number().int().optional(),
  scale: z.number().int().optional(),
}).strict();
const createTablePreviewSchema = z.object({
  connectionId: z.string().regex(/^[a-f0-9]{64}$/),
  draft: z.object({ schema: z.string().max(128), table: z.string().max(128), columns: z.array(createTableColumnSchema).max(50) }).strict(),
}).strict();
connectionsRouter.post('/schema/preview-create-table', async (req, res) => {
  const parsed = createTablePreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid table definition', details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { connectionId, draft } = parsed.data;
  const session = getDatabaseSession(connectionId);
  if (!session) { res.status(410).json({ error: 'The database session expired. Test the connection again.' }); return; }
  try { res.json(await previewCreateTable(session, connectionId, draft as { schema: string; table: string; columns: CreateTableColumnDraft[] })); }
  catch (error) {
    if (error instanceof SchemaOperationError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(422).json({ error: 'Could not validate this table against the connected database.' });
  }
});

connectionsRouter.post('/schema/create-table', async (req, res) => {
  const parsed = z.object({ connectionId: z.string().regex(/^[a-f0-9]{64}$/), planId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid table creation confirmation' }); return; }
  const { connectionId, planId } = parsed.data;
  const session = getDatabaseSession(connectionId);
  if (!session) { res.status(410).json({ error: 'The database session expired. Test the connection again.' }); return; }
  try { res.json(await executeCreateTable(session, connectionId, planId)); }
  catch (error) {
    if (error instanceof SchemaOperationError) { res.status(error.status).json({ error: error.message }); return; }
    const message = error instanceof Error ? error.message.split('\n', 1)[0].slice(0, 500) : 'The database rejected this table definition.';
    res.status(422).json({ error: message || 'The database rejected this table definition.' });
  }
});

connectionsRouter.post('/schema/preview-add-column', async (req, res) => {
  const parsed = z.object({ connectionId: z.string().regex(/^[a-f0-9]{64}$/), sql: z.string().min(1).max(5_000) }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter one supported ALTER TABLE statement under 5,000 characters.' }); return; }
  const { connectionId, sql } = parsed.data;
  const session = getDatabaseSession(connectionId);
  if (!session) { res.status(410).json({ error: 'The database session expired. Test the connection again.' }); return; }
  try { res.json(await previewAddColumn(session, connectionId, sql)); }
  catch (error) {
    if (error instanceof SchemaOperationError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(422).json({ error: 'Could not validate this column change against the connected database.' });
  }
});

connectionsRouter.post('/schema/add-column', async (req, res) => {
  const parsed = z.object({ connectionId: z.string().regex(/^[a-f0-9]{64}$/), planId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid column change confirmation' }); return; }
  const { connectionId, planId } = parsed.data;
  const session = getDatabaseSession(connectionId);
  if (!session) { res.status(410).json({ error: 'The database session expired. Test the connection again.' }); return; }
  try { res.json(await executeAddColumn(session, connectionId, planId)); }
  catch (error) {
    if (error instanceof SchemaOperationError) { res.status(error.status).json({ error: error.message }); return; }
    const message = error instanceof Error ? error.message.split('\n', 1)[0].slice(0, 500) : 'The database rejected this column change.';
    res.status(422).json({ error: message || 'The database rejected this column change.' });
  }
});

connectionsRouter.post('/introspect', async (req, res, next) => {
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid connection session' });
    return;
  }
  const session = getDatabaseSession(parsed.data.connectionId);
  if (!session) {
    res.status(410).json({ error: 'The database session expired. Test the connection again.' });
    return;
  }
  try {
    const result = await introspectDatabaseSchema(session);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

const recordsSchema = z.object({
  connectionId: z.string().regex(/^[a-f0-9]{64}$/),
  schema: z.string().min(1).max(128),
  table: z.string().min(1).max(128),
  page: z.coerce.number().int().min(0).max(10_000).default(0),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().max(200).default(''),
  sort: z.object({ column: z.string().min(1).max(128), direction: z.enum(['asc', 'desc']) }).strict().optional(),
}).strict();
const readQuerySchema = z.object({
  connectionId: z.string().regex(/^[a-f0-9]{64}$/),
  query: z.string().min(1).max(50_000),
}).strict();
connectionsRouter.post('/query', async (req, res) => {
  const parsed = readQuerySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Enter one SQL query under 50,000 characters.', details: parsed.error.flatten().fieldErrors });
    return;
  }
  const session = getDatabaseSession(parsed.data.connectionId);
  if (!session) {
    res.status(410).json({ error: 'The database session expired. Test the connection again.' });
    return;
  }
  try {
    res.json(await executeDatabaseQuery(session, parsed.data.query));
  } catch (error) {
    if (error instanceof ReadOnlyQueryValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof DatabaseQueryResultSizeError) {
      res.status(413).json({ error: 'This query result exceeds the 2 MB response limit. Return fewer or smaller columns and retry.' });
      return;
    }
    const message = error instanceof Error ? error.message.split('\n', 1)[0].slice(0, 500) : 'The database rejected this query.';
    res.status(422).json({ error: message || 'The database rejected this query.' });
  }
});

connectionsRouter.post('/records', async (req, res, next) => {
  const parsed = recordsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid record page request', details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { connectionId, schema, table, page, pageSize, sort, search } = parsed.data;
  const session = getDatabaseSession(connectionId);
  if (!session) {
    res.status(410).json({ error: 'The database session expired. Test the connection again.' });
    return;
  }
  try {
    res.json(await readDatabaseTablePage(session, schema, table, page, pageSize, sort, search));
  } catch (error) {
    if (error instanceof RecordSortColumnError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof PostgresTableNotFoundError) {
      res.status(404).json({ error: 'That table is no longer visible in this database session. Refresh the schema and try again.' });
      return;
    }
    if (error instanceof PostgresResultSizeError) {
      res.status(413).json({ error: 'This page exceeds the 2 MB response limit. Choose a smaller page size and retry.' });
      return;
    }
    next(error);
  }
});

const updateRecordSchema = z.object({
  connectionId: z.string().regex(/^[a-f0-9]{64}$/),
  schema: z.string().min(1).max(128),
  table: z.string().min(1).max(128),
  primaryKey: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 10),
  originalValues: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 50),
  changes: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 50),
}).strict();
connectionsRouter.post('/records/update', async (req, res) => {
  const parsed = updateRecordSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Provide a table, all primary-key values, and between 1 and 50 changed columns.' }); return; }
  const session = getDatabaseSession(parsed.data.connectionId);
  if (!session) { res.status(410).json({ error: 'The database session expired. Test the connection again.' }); return; }
  try { res.json(await updateDatabaseRecord(session, parsed.data)); }
  catch (error) {
    if (error instanceof RecordUpdateError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(422).json({ error: 'The database could not save this row. Check constraints, permissions, and the current row values.' });
  }
});

const recordMutationBase = z.object({
  connectionId: z.string().regex(/^[a-f0-9]{64}$/),
  schema: z.string().min(1).max(128),
  table: z.string().min(1).max(128),
}).strict();
const recordInsertSchema = recordMutationBase.extend({ values: z.record(z.unknown()).refine((value) => Object.keys(value).length <= 50) }).strict();
const recordDeleteSchema = recordMutationBase.extend({
  primaryKey: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 10),
  originalValues: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 250),
}).strict();
const recordPlanSchema = z.object({ connectionId: z.string().regex(/^[a-f0-9]{64}$/), planId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function mutationErrorMessage(error: unknown, action: 'insert' | 'delete') {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (['23505', 'ER_DUP_ENTRY'].includes(code)) return 'A row with these unique values already exists. Change the values and review again.';
  if (['23503', 'ER_ROW_IS_REFERENCED_2', 'ER_ROW_IS_REFERENCED'].includes(code)) return 'This row is referenced by another record and cannot be deleted yet.';
  if (['23502', 'ER_BAD_NULL_ERROR'].includes(code)) return 'A required column is missing. Provide a value and review again.';
  if (['23514', 'ER_CHECK_CONSTRAINT_VIOLATED'].includes(code)) return 'One of the values does not meet a database check constraint.';
  if (['42501', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR'].includes(code)) return 'The connected database user does not have permission to change this table.';
  return action === 'insert'
    ? 'The database rejected this row. Check required fields, data types, unique values, and permissions.'
    : 'The database could not delete this row. Refresh it and check related records and permissions.';
}
connectionsRouter.post('/records/preview-insert', async (req, res) => {
  const parsed = recordInsertSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Provide a table and no more than 50 field values.' }); return; }
  const session = getDatabaseSession(parsed.data.connectionId);
  if (!session) { res.status(410).json({ error: 'The database session expired. Test the connection again.' }); return; }
  try { res.json(await previewRecordInsert(session, parsed.data.connectionId, parsed.data)); }
  catch (error) {
    if (error instanceof RecordMutationError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(422).json({ error: mutationErrorMessage(error, 'insert') });
  }
});
connectionsRouter.post('/records/insert', async (req, res) => {
  const parsed = recordPlanSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Review a row before inserting it.' }); return; }
  const session = getDatabaseSession(parsed.data.connectionId);
  if (!session) { res.status(410).json({ error: 'The database session expired. Test the connection again.' }); return; }
  try { res.json(await executeRecordInsert(session, parsed.data.connectionId, parsed.data.planId)); }
  catch (error) {
    if (error instanceof RecordMutationError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(422).json({ error: mutationErrorMessage(error, 'insert') });
  }
});
connectionsRouter.post('/records/preview-delete', async (req, res) => {
  const parsed = recordDeleteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Select a row with a primary key to review its deletion.' }); return; }
  const session = getDatabaseSession(parsed.data.connectionId);
  if (!session) { res.status(410).json({ error: 'The database session expired. Test the connection again.' }); return; }
  try { res.json(await previewRecordDelete(session, parsed.data.connectionId, parsed.data)); }
  catch (error) {
    if (error instanceof RecordMutationError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(422).json({ error: 'Could not verify this row. Refresh the table and try again.' });
  }
});
connectionsRouter.post('/records/delete', async (req, res) => {
  const parsed = recordPlanSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Review a row before deleting it.' }); return; }
  const session = getDatabaseSession(parsed.data.connectionId);
  if (!session) { res.status(410).json({ error: 'The database session expired. Test the connection again.' }); return; }
  try { res.json(await executeRecordDelete(session, parsed.data.connectionId, parsed.data.planId)); }
  catch (error) {
    if (error instanceof RecordMutationError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(422).json({ error: mutationErrorMessage(error, 'delete') });
  }
});

connectionsRouter.delete('/:connectionId', async (req, res) => {
  const parsed = sessionSchema.safeParse({ connectionId: req.params.connectionId });
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid connection session' });
    return;
  }
  await closeDatabaseSession(parsed.data.connectionId);
  res.status(204).end();
});

connectionsRouter.post('/test', async (req, res, next) => {
  const parsed = testConnectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid connection details', details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const result = await testDatabaseConnection(parsed.data);
    res.json(result);
  } catch (error) {
    if (error instanceof DatabaseHostValidationError) { res.status(400).json({ error: error.message }); return; }
    next(error);
  }
});
