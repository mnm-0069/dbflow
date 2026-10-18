import { useState } from 'react';
import { Check, ShieldCheck, X } from 'lucide-react';

type Preview = { planId: string; sql: string; expiresInSeconds: number };
type ExecutedChange = { schema: string; table: string; column: string };
const api = 'http://localhost:4000/api/connections';

export function ReviewAddColumnDialog({ connectionId, sql, onClose, onExecuted }: {
  connectionId: string; sql: string; onClose: () => void;
  onExecuted: (change: ExecutedChange) => Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const previewSql = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`${api}/schema/preview-add-column`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, sql }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'This schema change could not be previewed.');
      setPreview(payload as Preview); setReviewed(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reach the local API.'); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (!preview || !reviewed) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`${api}/schema/add-column`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, planId: preview.planId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'The database rejected this column change.');
      await onExecuted({ schema: payload.schema, table: payload.table, column: payload.column });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not apply this column change.'); setPreview(null); setReviewed(false); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="connection-modal ddl-review-modal" role="dialog" aria-modal="true" aria-labelledby="ddl-review-title" aria-describedby="ddl-review-description">
    <div className="modal-heading"><div className="modal-icon"><ShieldCheck size={19}/></div><button className="icon-button" aria-label="Close schema change review" onClick={onClose} disabled={busy}><X size={17}/></button></div>
    <h2 id="ddl-review-title">Review schema change</h2><p id="ddl-review-description">This workflow allows one <strong>ADD COLUMN</strong> operation on a base table. Destructive statements and other DDL are rejected.</p>
    {preview && <div className="sql-preview"><div><strong>Normalized SQL</strong><span>Expires in {preview.expiresInSeconds} seconds</span></div><pre>{preview.sql}</pre><label className="draft-confirm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)}/> I reviewed this SQL and want to add the column.</label></div>}
    {error && <div className="connection-result error" role="alert">{error}</div>}
    <div className="create-table-actions"><button className="button button-quiet" type="button" onClick={onClose} disabled={busy}>Cancel</button>{preview ? <button className="button button-primary" type="button" disabled={!reviewed || busy} onClick={() => void execute()}>{busy ? 'Applying…' : 'Apply column change'} <Check size={15}/></button> : <button className="button button-primary" type="button" disabled={busy} onClick={() => void previewSql()}>{busy ? 'Validating…' : 'Validate and preview SQL'}</button>}</div>
  </section></div>;
}
