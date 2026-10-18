import { useState } from 'react';
import { Check, X } from 'lucide-react';

type Column = { name: string; type: string; key?: 'pk' | 'fk' | 'pk-fk'; generated?: boolean; nullable?: boolean };
type DraftValue = { value: string; isNull: boolean; included: boolean };
const api = 'http://localhost:4000/api/connections';
const toText = (value: unknown) => value === null || value === undefined ? '' : typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);

export function EditRecordDialog({ connectionId, schema, table, row, columns, onClose, onSaved }: {
  connectionId: string; schema: string; table: string; row: Record<string, unknown>; columns: Column[];
  onClose: () => void; onSaved: () => Promise<void>;
}) {
  const keys = columns.filter((column) => column.key === 'pk' || column.key === 'pk-fk');
  const editable = columns.filter((column) => column.key !== 'pk' && column.key !== 'pk-fk' && !column.generated);
  const [draft, setDraft] = useState<Record<string, DraftValue>>(() => Object.fromEntries(editable.map((column) => [column.name, { value: toText(row[column.name]), isNull: row[column.name] === null, included: false }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (name: string, patch: Partial<DraftValue>) => setDraft((current) => ({ ...current, [name]: { ...current[name]!, ...patch } }));
  const save = async () => {
    const changedColumns = Object.keys(draft).filter((name) => draft[name]!.included);
    if (!changedColumns.length) { setError('Choose at least one field to save.'); return; }
    setBusy(true); setError('');
    try {
      const changes = Object.fromEntries(changedColumns.map((name) => [name, draft[name]!.isNull ? null : draft[name]!.value]));
      const originalValues = Object.fromEntries(changedColumns.map((name) => [name, row[name] ?? null]));
      const primaryKey = Object.fromEntries(keys.map((column) => [column.name, row[column.name]]));
      const response = await fetch(`${api}/records/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, schema, table, primaryKey, originalValues, changes }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'The database could not save this row.');
      await onSaved(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the selected row.'); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="connection-modal edit-record-modal" role="dialog" aria-modal="true" aria-labelledby="edit-record-title" aria-describedby="edit-record-description">
    <div className="modal-heading"><div className="modal-icon"><Check size={19}/></div><button className="icon-button" aria-label="Close row editor" onClick={onClose} disabled={busy}><X size={17}/></button></div>
    <h2 id="edit-record-title">Edit row</h2><p id="edit-record-description">Edit one row in <strong>{schema}.{table}</strong>. Primary-key values identify the row and cannot be changed here.</p>
    <div className="edit-record-keys"><strong>Row key</strong>{keys.map((column) => <span key={column.name}><code>{column.name}</code> {toText(row[column.name])}</span>)}</div>
    <div className="edit-record-fields">{editable.map((column) => <div className="edit-record-field" key={column.name}>
      <label className="edit-field-value"><span>{column.name} <small>{column.type}</small></span><input name={column.name} autoComplete="off" value={draft[column.name]?.value ?? ''} disabled={draft[column.name]?.isNull || busy} onChange={(event) => update(column.name, { value: event.target.value, included: true, isNull: false })}/></label>
      <label className="edit-field-include"><input type="checkbox" aria-label={`Save ${column.name}`} checked={Boolean(draft[column.name]?.included)} disabled={busy} onChange={(event) => update(column.name, { included: event.target.checked })}/> Save</label>
      {column.nullable && <label className="edit-field-include"><input type="checkbox" aria-label={`Set ${column.name} to NULL`} checked={Boolean(draft[column.name]?.isNull)} disabled={busy} onChange={(event) => update(column.name, { isNull: event.target.checked, included: true })}/> Set NULL</label>}
    </div>)}{editable.length === 0 && <div className="empty-edit-fields">This table has no editable non-key columns.</div>}</div>
    {error && <div className="connection-result error" role="alert">{error}</div>}
    <div className="create-table-actions"><button className="button button-quiet" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" onClick={() => void save()} disabled={busy || editable.length === 0}>{busy ? 'Saving…' : 'Save changes'} <Check size={15}/></button></div>
  </section></div>;
}
