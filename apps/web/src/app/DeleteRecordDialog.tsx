import { useState } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';

type Column = { name: string; key?: 'pk' | 'fk' | 'pk-fk' };
type Preview = { planId: string; expiresInSeconds: number };
const api = 'http://localhost:4000/api/connections';
const format = (value: unknown) => value === null ? 'NULL' : value === '' ? '(empty string)' : typeof value === 'string' ? value : JSON.stringify(value);

export function DeleteRecordDialog({ connectionId, schema, table, row, columns, onClose, onDeleted }: {
  connectionId: string; schema: string; table: string; row: Record<string, unknown>; columns: Column[]; onClose: () => void; onDeleted: () => Promise<void>;
}) {
  const keys = columns.filter((column) => column.key === 'pk' || column.key === 'pk-fk');
  const primaryKey = Object.fromEntries(keys.map((column) => [column.name, row[column.name]]));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reviewDelete = async () => {
    setBusy(true); setError(''); setPreview(null); setReviewed(false);
    try {
      const response = await fetch(`${api}/records/preview-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, schema, table, primaryKey, originalValues: row }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Could not review this row deletion.');
      setPreview(payload as Preview);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reach the local API.'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!preview || !reviewed) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`${api}/records/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, planId: preview.planId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'The database could not delete this row.');
      await onDeleted(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete this row.'); setPreview(null); setReviewed(false); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="connection-modal delete-record-modal" role="dialog" aria-modal="true" aria-labelledby="delete-record-title" aria-describedby="delete-record-description">
    <div className="modal-heading"><div className="delete-record-icon"><AlertTriangle size={19}/></div><button className="icon-button" aria-label="Close delete-row dialog" onClick={onClose} disabled={busy}><X size={17}/></button></div>
    <h2 id="delete-record-title">Delete row</h2><p id="delete-record-description">Review the selected record in <strong>{schema}.{table}</strong>. This permanently deletes one row from the connected database.</p>
    <div className="delete-record-key"><strong>Primary key</strong>{keys.map((column) => <span key={column.name}><code>{column.name}</code> {format(row[column.name])}</span>)}</div>
    <div className="record-review-preview delete-row-preview"><strong>Selected row</strong>{columns.slice(0, 8).map((column) => <span key={column.name}><code>{column.name}</code> {format(row[column.name])}</span>)}{columns.length > 8 && <span>And {columns.length - 8} more columns</span>}<small>DBFLOW will compare the full row snapshot again before deleting.</small></div>
    {error && <div className="connection-result error" role="alert">{error}</div>}
    {preview && <div className="record-review-preview"><div><strong>Deletion verified</strong><span>Confirmation expires in {preview.expiresInSeconds} seconds</span></div><label className="draft-confirm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)}/> I reviewed this row and want to permanently delete it.</label></div>}
    <div className="create-table-actions"><button className="button button-quiet" type="button" onClick={onClose} disabled={busy}>Cancel</button>{preview ? <button className="button button-danger" type="button" disabled={!reviewed || busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete row'} <Trash2 size={15}/></button> : <button className="button button-danger" type="button" disabled={busy || keys.length === 0} onClick={() => void reviewDelete()}>{busy ? 'Checking row…' : 'Review deletion'} <Trash2 size={15}/></button>}</div>
  </section></div>;
}
