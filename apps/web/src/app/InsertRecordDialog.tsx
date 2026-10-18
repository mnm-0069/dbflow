import { useState } from 'react';
import { Check, Plus, X } from 'lucide-react';

type Column = { name: string; type: string; generated?: boolean; identity?: boolean; nullable?: boolean; hasDefault?: boolean };
type Field = { value: string; included: boolean; isNull: boolean };
type Preview = { planId: string; expiresInSeconds: number };
const api = 'http://localhost:4000/api/connections';
const display = (field: Field) => field.isNull ? 'NULL' : field.value === '' ? '(empty string)' : field.value;

export function InsertRecordDialog({ connectionId, schema, table, columns, onClose, onInserted }: {
  connectionId: string; schema: string; table: string; columns: Column[]; onClose: () => void; onInserted: () => Promise<void>;
}) {
  const insertable = columns.filter((column) => !column.generated && !column.identity);
  const [fields, setFields] = useState<Record<string, Field>>(() => Object.fromEntries(insertable.map((column) => [column.name, {
    value: '', included: column.nullable === false && !column.hasDefault, isNull: false,
  }])));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = (name: string, patch: Partial<Field>) => {
    setFields((current) => ({ ...current, [name]: { ...current[name]!, ...patch } }));
    setPreview(null); setReviewed(false); setError('');
  };
  const values = Object.fromEntries(Object.entries(fields).filter(([, field]) => field.included).map(([name, field]) => [name, field.isNull ? null : field.value]));
  const createPreview = async () => {
    setBusy(true); setError(''); setPreview(null); setReviewed(false);
    try {
      const response = await fetch(`${api}/records/preview-insert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, schema, table, values }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Could not review this row.');
      setPreview(payload as Preview);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reach the local API.'); }
    finally { setBusy(false); }
  };
  const insert = async () => {
    if (!preview || !reviewed) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`${api}/records/insert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, planId: preview.planId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'The database rejected this row.');
      await onInserted(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not insert this row.'); setPreview(null); setReviewed(false); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="connection-modal insert-record-modal" role="dialog" aria-modal="true" aria-labelledby="insert-record-title" aria-describedby="insert-record-description">
    <div className="modal-heading"><div className="modal-icon"><Plus size={19}/></div><button className="icon-button" aria-label="Close add-row dialog" onClick={onClose} disabled={busy}><X size={17}/></button></div>
    <h2 id="insert-record-title">Add row</h2><p id="insert-record-description">Add one record to <strong>{schema}.{table}</strong>. Review the values before they are sent to the database.</p>
    <div className="insert-record-fields">{insertable.map((column) => {
      const field = fields[column.name]!;
      const required = column.nullable === false && !column.hasDefault;
      return <div className="insert-record-field" key={column.name}>
        <label className="insert-field-value"><span>{column.name} <small>{column.type}{required ? ' · required' : column.hasDefault ? ' · default available' : ''}</small></span><input name={column.name} autoComplete="off" value={field.value} disabled={!field.included || field.isNull || busy} onChange={(event) => change(column.name, { value: event.target.value, included: true, isNull: false })} placeholder={column.hasDefault ? 'Use database default' : field.isNull ? 'NULL' : 'Enter a value'}/></label>
        <label className="insert-field-include"><input type="checkbox" aria-label={`Include ${column.name}`} checked={field.included} disabled={required || busy} onChange={(event) => change(column.name, { included: event.target.checked, isNull: false })}/>{required ? 'Required' : 'Include'}</label>
        {column.nullable !== false && <label className="insert-field-include"><input type="checkbox" aria-label={`Set ${column.name} to NULL`} checked={field.isNull} disabled={!field.included || busy} onChange={(event) => change(column.name, { isNull: event.target.checked, included: true })}/> NULL</label>}
      </div>;
    })}{insertable.length === 0 && <div className="empty-edit-fields">All columns are generated by the database. A default row will be requested.</div>}</div>
    <div className="record-mutation-note">Leave optional fields excluded to use their database defaults. Values are parameterized and generated columns stay under database control.</div>
    {error && <div className="connection-result error" role="alert">{error}</div>}
    {preview && <div className="record-review-preview"><div><strong>Review these values</strong><span>Review expires in {preview.expiresInSeconds} seconds</span></div>{Object.keys(values).length ? Object.entries(values).map(([name, value]) => <span key={name}><code>{name}</code> {display(fields[name]!)}</span>) : <span>Use database defaults for every column.</span>}<label className="draft-confirm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)}/> I reviewed these values and want to insert one row.</label></div>}
    <div className="create-table-actions"><button className="button button-quiet" type="button" onClick={onClose} disabled={busy}>Cancel</button>{preview ? <button className="button button-primary" type="button" disabled={!reviewed || busy} onClick={() => void insert()}>{busy ? 'Adding…' : 'Add row'} <Check size={15}/></button> : <button className="button button-primary" type="button" disabled={busy} onClick={() => void createPreview()}>{busy ? 'Checking values…' : 'Review row'}</button>}</div>
  </section></div>;
}
