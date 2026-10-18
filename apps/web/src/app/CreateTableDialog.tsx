import { useState } from 'react';
import { Check, Plus, ShieldCheck, Trash2, X } from 'lucide-react';

type Engine = 'postgres' | 'mysql';
type ColumnType = 'integer' | 'bigint' | 'varchar' | 'text' | 'boolean' | 'timestamp' | 'decimal';
type ColumnDraft = { name: string; type: ColumnType; nullable: boolean; primaryKey: boolean; length: string; precision: string; scale: string };
type Draft = { schema: string; table: string; columns: ColumnDraft[] };
type Preview = { planId: string; sql: string; expiresInSeconds: number };

const newColumn = (name = ''): ColumnDraft => ({ name, type: 'text', nullable: true, primaryKey: false, length: '120', precision: '10', scale: '2' });
const api = 'http://localhost:4000/api/connections';

export function CreateTableDialog({ connectionId, engine, initialSchema, onClose, onCreated }: {
  connectionId: string; engine: Engine; initialSchema: string; onClose: () => void;
  onCreated: (schema: string, table: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>({ schema: initialSchema, table: '', columns: [{ ...newColumn('id'), type: 'integer', nullable: false, primaryKey: true }, newColumn('name')] });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = (next: Draft) => { setDraft(next); setPreview(null); setReviewed(false); setError(''); };
  const updateColumn = (index: number, patch: Partial<ColumnDraft>) => changed({ ...draft, columns: draft.columns.map((column, i) => i === index ? { ...column, ...patch, ...(patch.primaryKey ? { nullable: false } : {}) } : column) });
  const previewSql = async () => {
    setBusy(true); setError(''); setPreview(null); setReviewed(false);
    try {
      const response = await fetch(`${api}/schema/preview-create-table`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, draft: {
        schema: draft.schema, table: draft.table,
        columns: draft.columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable, primaryKey: column.primaryKey,
          ...(column.type === 'varchar' ? { length: Number(column.length) } : {}), ...(column.type === 'decimal' ? { precision: Number(column.precision), scale: Number(column.scale) } : {}) })),
      } }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Could not preview this table.');
      setPreview(payload as Preview);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reach the local API.'); }
    finally { setBusy(false); }
  };
  const createTable = async () => {
    if (!preview || !reviewed) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`${api}/schema/create-table`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, planId: preview.planId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'The database rejected this table definition.');
      await onCreated(payload.schema, payload.table);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create this table.'); setPreview(null); setReviewed(false); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="connection-modal create-table-modal" role="dialog" aria-modal="true" aria-labelledby="create-table-title" aria-describedby="create-table-description">
    <div className="modal-heading"><div className="modal-icon"><Plus size={19}/></div><button className="icon-button" aria-label="Close table designer" onClick={onClose} disabled={busy}><X size={17}/></button></div>
    <h2 id="create-table-title">Create table</h2><p id="create-table-description">Draft a table for <strong>{engine === 'postgres' ? 'PostgreSQL' : 'MySQL'}</strong>. Review the generated SQL before it runs against <strong>{draft.schema || 'your database'}</strong>.</p>
    <div className="create-table-target"><label>Schema<input value={draft.schema} onChange={(event) => changed({ ...draft, schema: event.target.value })} disabled={engine === 'mysql'} aria-label="Schema"/></label><label>Table name<input value={draft.table} onChange={(event) => changed({ ...draft, table: event.target.value })} placeholder="e.g. projects" autoFocus/></label></div>
    <div className="draft-columns-heading"><strong>Columns</strong><span>{draft.columns.length} / 50</span></div>
    <div className="draft-columns">{draft.columns.map((column, index) => <div className="draft-column" key={index}>
      <label className="draft-column-name"><span>Name</span><input value={column.name} onChange={(event) => updateColumn(index, { name: event.target.value })} placeholder="column_name"/></label>
      <label className="draft-column-type"><span>Type</span><select value={column.type} onChange={(event) => updateColumn(index, { type: event.target.value as ColumnType })}><option value="integer">Integer</option><option value="bigint">Big integer</option><option value="varchar">Varchar</option><option value="text">Text</option><option value="boolean">Boolean</option><option value="timestamp">Timestamp</option><option value="decimal">Decimal</option></select></label>
      {column.type === 'varchar' && <label className="draft-column-size"><span>Length</span><input type="number" min="1" max="255" value={column.length} onChange={(event) => updateColumn(index, { length: event.target.value })}/></label>}
      {column.type === 'decimal' && <div className="draft-decimal"><label><span>Precision</span><input type="number" min="1" max="38" value={column.precision} onChange={(event) => updateColumn(index, { precision: event.target.value })}/></label><label><span>Scale</span><input type="number" min="0" max="38" value={column.scale} onChange={(event) => updateColumn(index, { scale: event.target.value })}/></label></div>}
      <label className="draft-check"><input type="checkbox" checked={column.primaryKey} onChange={(event) => updateColumn(index, { primaryKey: event.target.checked, ...(event.target.checked ? { nullable: false } : {}) })}/> Primary key</label>
      <label className="draft-check"><input type="checkbox" checked={column.nullable} disabled={column.primaryKey} onChange={(event) => updateColumn(index, { nullable: event.target.checked })}/> Nullable</label>
      <button type="button" className="draft-remove" aria-label={`Remove ${column.name || 'column'}`} disabled={draft.columns.length === 1} onClick={() => changed({ ...draft, columns: draft.columns.filter((_, i) => i !== index) })}><Trash2 size={15}/></button>
    </div>)}</div>
    <button type="button" className="text-button draft-add-column" disabled={draft.columns.length >= 50} onClick={() => changed({ ...draft, columns: [...draft.columns, newColumn(`column_${draft.columns.length + 1}`)] })}><Plus size={15}/> Add column</button>
    <div className="modal-note"><ShieldCheck size={15}/><span>The API generates and executes this statement on the active database session. It does not run arbitrary SQL from this form. MySQL DDL may commit implicitly.</span></div>
    {error && <div className="connection-result error" role="alert">{error}</div>}
    {preview && <div className="sql-preview"><div><strong>SQL preview</strong><span>Expires in {preview.expiresInSeconds} seconds</span></div><pre>{preview.sql}</pre><label className="draft-confirm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)}/> I reviewed this SQL and want to create the table.</label></div>}
    <div className="create-table-actions"><button className="button button-quiet" type="button" onClick={onClose} disabled={busy}>Cancel</button>{preview ? <button className="button button-primary" type="button" disabled={!reviewed || busy} onClick={() => void createTable()}>{busy ? 'Creating…' : 'Create table'} <Check size={15}/></button> : <button className="button button-primary" type="button" disabled={busy} onClick={() => void previewSql()}>{busy ? 'Generating preview…' : 'Review SQL'}</button>}</div>
  </section></div>;
}
