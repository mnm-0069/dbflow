import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { AgGridReact } from '@ag-grid-community/react';
import { ModuleRegistry } from '@ag-grid-community/core';
import { ClientSideRowModelModule } from '@ag-grid-community/client-side-row-model';
import { Background, Controls, ReactFlow, type Edge, type Node, type NodeTypes, type ReactFlowInstance, Handle, Position } from '@xyflow/react';
import {
  Activity, ArrowDownUp, ArrowLeftRight, ArrowRight, Braces, Check, ChevronDown,
  ChevronRight, CircleHelp, Clock3, Code2, Command, Database, Ellipsis, Eye,
  FileCode2, Filter, GitBranch, GraduationCap, Grip, HardDrive, HelpCircle, History,
  KeyRound, LayoutDashboard, Lightbulb, Link2, ListFilter, LockKeyhole, Maximize2, Menu,
  MoreHorizontal, PanelLeftClose, Plus, Search, Settings2, ShieldCheck, Sparkles,
  Table2, TerminalSquare, X, Zap,
} from 'lucide-react';
import { CreateTableDialog } from './CreateTableDialog';
import { ReviewAddColumnDialog } from './ReviewAddColumnDialog';
import { EditRecordDialog } from './EditRecordDialog';

ModuleRegistry.registerModules([ClientSideRowModelModule]);
const Editor = lazy(() => import('@monaco-editor/react'));

type TableNodeData = { label: string; subtitle: string; columns: { name: string; type: string; key?: 'pk' | 'fk' | 'pk-fk' }[]; accent: string };
type LiveSchema = {
  engine: 'postgres' | 'mysql';
  database: string;
  introspectedAt: string;
  tables: Array<{
    schema: string;
    name: string;
    columns: Array<{ name: string; type: string; key?: 'pk' | 'fk' | 'pk-fk'; generated?: boolean; nullable?: boolean }>;
    foreignKeys: Array<{ column: string; referencedSchema: string; referencedTable: string; referencedColumn: string }>;
  }>;
};
type LiveRecordsPage = {
  schema: string;
  table: string;
  page: number;
  pageSize: number;
  hasMore: boolean;
  rows: Array<Record<string, unknown>>;
};
type LiveRecordSort = { column: string; direction: 'asc' | 'desc' };
type SqlWorkspaceResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  source: 'database' | 'demo';
};

function TableNode({ data }: { data: any }) {
  return <div className="table-node">
    <Handle type="target" position={Position.Left} className="node-handle" />
    <div className="table-node-head"><div className="table-icon"><Table2 size={14} /></div><div className="table-head-copy"><strong>{data.label}</strong><span>{data.subtitle}</span></div><Ellipsis size={15} className="muted-icon" /></div>
    <div className="table-node-columns">{data.columns.map((col: TableNodeData['columns'][number]) => <div className="node-column" key={col.name}><span className="column-symbol">{col.key === 'pk-fk' ? <><KeyRound size={10}/><Link2 size={10}/></> : col.key === 'pk' ? <KeyRound size={11}/> : col.key === 'fk' ? <Link2 size={11}/> : <span className="tiny-dot"/>}</span><span className="column-name">{col.name}</span><span className="column-type">{col.type}</span></div>)}</div>
    <div className="table-node-foot"><span><span className="status-dot" /> Synced</span><span>{data.columns.length} columns</span></div>
    <Handle type="source" position={Position.Right} className="node-handle" />
  </div>;
}
const nodeTypes: NodeTypes = { tableNode: TableNode };
const schemaTableId = (schema: string, table: string) => JSON.stringify([schema, table]);

function BrandMark() {
  return <svg aria-hidden="true" viewBox="0 0 36 36" fill="none">
    <path d="M7.25 10.25c0-2.05 4.82-3.72 10.75-3.72s10.75 1.67 10.75 3.72S23.93 14 18 14 7.25 12.3 7.25 10.25Z" stroke="currentColor" strokeWidth="1.8"/>
    <path d="M7.25 10.4v6.1c0 2.05 4.82 3.72 10.75 3.72 1.5 0 2.92-.13 4.18-.36M7.25 16.3c0 2.05 4.82 3.72 10.75 3.72" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    <path d="M7.25 16.4v6.05c0 2.05 4.82 3.72 10.75 3.72 1.28 0 2.5-.1 3.62-.29" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    <path d="M18 20.1h3.2c2.1 0 3.8-1.7 3.8-3.8v-1.1h3.5m-2.1-1.8 2.1 1.8-2.1 1.8" stroke="#BDEFD9" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

function makeSchemaGraph(schema: LiveSchema) {
  const nodes: Node[] = schema.tables.map((table, index) => ({
    id: schemaTableId(table.schema, table.name), type: 'tableNode',
    position: { x: 90 + (index % 2) * 340, y: 80 + Math.floor(index / 2) * 300 },
    data: { label: table.name, subtitle: `${table.schema} · table`, accent: 'blue', columns: table.columns },
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: Edge[] = schema.tables.flatMap((table) => table.foreignKeys.flatMap((foreignKey, index) => {
    const source = schemaTableId(foreignKey.referencedSchema, foreignKey.referencedTable);
    const target = schemaTableId(table.schema, table.name);
    if (!nodeIds.has(source) || !nodeIds.has(target)) return [];
    return [{ id: `fk:${target}:${foreignKey.column}:${index}`, source, target, label: `${foreignKey.column} → ${foreignKey.referencedColumn}`, type: 'smoothstep', style: { stroke: '#3569c8', strokeWidth: 1.7 }, labelStyle: { fill: '#475467', fontSize: 10 }, labelBgStyle: { fill: '#ffffff', fillOpacity: 1 } } as Edge];
  }));
  return { nodes, edges };
}

const initialNodes: Node[] = [
  { id: 'users', type: 'tableNode', position: { x: 90, y: 80 }, data: { label: 'users', subtitle: 'public · table', accent: 'violet', columns: [{ name: 'id', type: 'uuid', key: 'pk' }, { name: 'full_name', type: 'varchar(120)' }, { name: 'email', type: 'varchar(255)' }, { name: 'created_at', type: 'timestamp' }] } },
  { id: 'orders', type: 'tableNode', position: { x: 430, y: 210 }, data: { label: 'orders', subtitle: 'public · table', accent: 'blue', columns: [{ name: 'id', type: 'uuid', key: 'pk' }, { name: 'user_id', type: 'uuid', key: 'fk' }, { name: 'total', type: 'numeric(10,2)' }, { name: 'status', type: 'varchar(24)' }] } },
  { id: 'order_items', type: 'tableNode', position: { x: 430, y: 80 }, data: { label: 'order_items', subtitle: 'public · table', accent: 'mint', columns: [{ name: 'id', type: 'uuid', key: 'pk' }, { name: 'order_id', type: 'uuid', key: 'fk' }, { name: 'product_id', type: 'uuid', key: 'fk' }, { name: 'quantity', type: 'integer' }] } },
  { id: 'products', type: 'tableNode', position: { x: 90, y: 380 }, data: { label: 'products', subtitle: 'public · table', accent: 'orange', columns: [{ name: 'id', type: 'uuid', key: 'pk' }, { name: 'name', type: 'varchar(180)' }, { name: 'price', type: 'numeric(10,2)' }, { name: 'stock', type: 'integer' }] } },
];
const initialEdges: Edge[] = [
  { id: 'e1', source: 'users', target: 'orders', label: '1 : N', type: 'smoothstep', animated: false, style: { stroke: '#7771e8', strokeWidth: 1.7 }, labelStyle: { fill: '#b7b5d8', fontSize: 10 }, labelBgStyle: { fill: '#ffffff', fillOpacity: 1 } },
  { id: 'e2', source: 'orders', target: 'order_items', label: '1 : N', type: 'smoothstep', style: { stroke: '#7771e8', strokeWidth: 1.7 }, labelStyle: { fill: '#b7b5d8', fontSize: 10 }, labelBgStyle: { fill: '#ffffff', fillOpacity: 1 } },
  { id: 'e3', source: 'products', target: 'order_items', label: '1 : N', type: 'smoothstep', style: { stroke: '#7771e8', strokeWidth: 1.7 }, labelStyle: { fill: '#b7b5d8', fontSize: 10 }, labelBgStyle: { fill: '#ffffff', fillOpacity: 1 } },
];

const sampleRows = [
  { id: 'ORD-1042', user_id: 'USR-0081', total: 249.99, status: 'completed', created_at: '2026-10-18 09:42:18' },
  { id: 'ORD-1041', user_id: 'USR-0024', total: 89.5, status: 'processing', created_at: '2026-10-18 09:38:03' },
  { id: 'ORD-1040', user_id: 'USR-0145', total: 1299.0, status: 'completed', created_at: '2026-10-18 09:21:47' },
  { id: 'ORD-1039', user_id: 'USR-0019', total: 42.0, status: 'pending', created_at: '2026-10-18 08:56:12' },
  { id: 'ORD-1038', user_id: 'USR-0081', total: 315.75, status: 'completed', created_at: '2026-10-17 22:14:52' },
  { id: 'ORD-1037', user_id: 'USR-0033', total: 78.25, status: 'cancelled', created_at: '2026-10-17 21:50:10' },
  { id: 'ORD-1036', user_id: 'USR-0090', total: 512.0, status: 'processing', created_at: '2026-10-17 21:02:37' },
  { id: 'ORD-1035', user_id: 'USR-0011', total: 159.99, status: 'completed', created_at: '2026-10-17 19:48:21' },
];
const initialSql = `SELECT *\nFROM orders\nLIMIT 100;`;

type Section = 'overview' | 'schema' | 'data' | 'sql' | 'learning';
function App() {
  const [section, setSection] = useState<Section>('schema');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 761px)').matches);
  const [activeTable, setActiveTable] = useState('orders');
  const [sql, setSql] = useState(initialSql);
  const [sqlResult, setSqlResult] = useState<SqlWorkspaceResult | null>(null);
  const [sqlBusy, setSqlBusy] = useState(false);
  const [sqlError, setSqlError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [showConnection, setShowConnection] = useState(false);
  const [connectionEngine, setConnectionEngine] = useState<'postgres' | 'mysql'>('postgres');
  const [connectionForm, setConnectionForm] = useState({ host: 'localhost', port: '5432', database: 'postgres', username: 'postgres', password: '', ssl: false });
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionResult, setConnectionResult] = useState('');
  const [connectionVerified, setConnectionVerified] = useState(false);
  const [liveConnectionId, setLiveConnectionId] = useState<string | null>(null);
  const [pendingConnectionId, setPendingConnectionId] = useState<string | null>(null);
  const [liveRecords, setLiveRecords] = useState<LiveRecordsPage | null>(null);
  const [liveSort, setLiveSort] = useState<LiveRecordSort | null>(null);
  const [selectedLiveRow, setSelectedLiveRow] = useState<Record<string, unknown> | null>(null);
  const [showEditRecord, setShowEditRecord] = useState(false);
  const [recordsBusy, setRecordsBusy] = useState(false);
  const [recordsError, setRecordsError] = useState('');
  const [toast, setToast] = useState('');
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [schemaFlow, setSchemaFlow] = useState<ReactFlowInstance | null>(null);
  const [liveSchema, setLiveSchema] = useState<LiveSchema | null>(null);
  const [showCreateTable, setShowCreateTable] = useState(false);
  const [showAddColumnReview, setShowAddColumnReview] = useState(false);
  const [schemaNotice, setSchemaNotice] = useState('');
  const [schemaRefreshTarget, setSchemaRefreshTarget] = useState<{ schema: string; table: string; column?: string } | null>(null);
  const [schemaRefreshBusy, setSchemaRefreshBusy] = useState(false);
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2800); };
  const selectedLiveTable = liveSchema?.tables.find((table) => schemaTableId(table.schema, table.name) === activeTable);
  const liveForeignKeyCount = selectedLiveTable?.foreignKeys.length ?? 0;
  useEffect(() => {
    if (!liveSchema || !schemaFlow) return;
    const timer = window.setTimeout(() => { void schemaFlow.fitView({ padding: 0.12 }); }, 120);
    return () => window.clearTimeout(timer);
  }, [liveSchema, schemaFlow]);
  const onNodesChange = useCallback((changes: any[]) => setNodes((nds) => {
    let next = nds;
    changes.forEach((change) => {
      if (change.type === 'position' && change.position) next = next.map((node) => node.id === change.id ? { ...node, position: change.position } : node);
      if (change.type === 'select') next = next.map((node) => node.id === change.id ? { ...node, selected: change.selected } : node);
    });
    return next;
  }), []);
  const onEdgesChange = useCallback((changes: any[]) => setEdges((eds) => eds.filter((edge) => !changes.some((change) => change.id === edge.id && change.type === 'remove'))), []);
  const colDefs = useMemo(() => [
    { field: 'id', headerName: 'ORDER ID', minWidth: 140, flex: 1, cellClass: 'mono-cell' },
    { field: 'user_id', headerName: 'USER ID', minWidth: 130, flex: 1, cellClass: 'mono-cell' },
    { field: 'total', headerName: 'TOTAL', minWidth: 100, flex: 0.8, valueFormatter: (p: any) => `$${Number(p.value).toFixed(2)}` },
    { field: 'status', headerName: 'STATUS', minWidth: 125, flex: 0.9, cellRenderer: (p: any) => <span className={`status-pill ${p.value}`}>{p.value}</span> },
    { field: 'created_at', headerName: 'CREATED AT', minWidth: 180, flex: 1.2, cellClass: 'mono-cell' },
  ], []);
  const liveRecordTable = liveRecords && liveSchema?.tables.find((table) => table.schema === liveRecords.schema && table.name === liveRecords.table);
  const livePrimaryKeyColumns = liveRecordTable?.columns.filter((column) => column.key === 'pk' || column.key === 'pk-fk') ?? [];
  const liveColDefs = useMemo(() => liveRecordTable?.columns.map((column) => ({
    field: column.name,
    headerName: column.name.replaceAll('_', ' ').toUpperCase(),
    minWidth: 130,
    flex: 1,
    cellClass: 'mono-cell',
  })) ?? [], [liveRecordTable]);
  const sqlColDefs = useMemo(() => sqlResult?.columns.map((column) => ({
    field: column,
    headerName: column.replaceAll('_', ' ').toUpperCase(),
    minWidth: 130,
    flex: 1,
    cellClass: 'mono-cell',
  })) ?? [], [sqlResult]);
  const demoFilteredRows = sampleRows.filter((row) => Object.values(row).some((value) => String(value).toLowerCase().includes(searchText.toLowerCase())));
  const liveFilteredRows = liveRecords?.rows.filter((row) => Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(searchText.toLowerCase()))) ?? [];

  const navItems: { key: Section; label: string; icon: any; group: string }[] = [
    { key: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'WORKSPACE' },
    { key: 'schema', label: 'Schema designer', icon: GitBranch, group: 'WORKSPACE' },
    { key: 'data', label: 'Data explorer', icon: Table2, group: 'WORKSPACE' },
    { key: 'sql', label: 'SQL workspace', icon: TerminalSquare, group: 'WORKSPACE' },
    { key: 'learning', label: 'Learn databases', icon: GraduationCap, group: 'LEARN' },
  ];
  const title = ({ overview: 'Overview', schema: 'Schema designer', data: 'Data explorer', sql: 'SQL workspace', learning: 'Learn databases' } as Record<Section, string>)[section];
  const runQuery = async () => {
    setSqlError('');
    if (!liveConnectionId || !liveSchema) {
      setSqlResult({ columns: Object.keys(sampleRows[0] ?? {}), rows: sampleRows, rowCount: sampleRows.length, truncated: false, elapsedMs: 0, source: 'demo' });
      return;
    }
    setSqlBusy(true);
    setSqlResult(null);
    try {
      const response = await fetch('http://localhost:4000/api/connections/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: liveConnectionId, query: sql }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (response.status === 410) resetLiveDatabase();
        throw new Error(payload.error ?? 'The database rejected this query.');
      }
      setSqlResult({ ...payload, source: 'database' } as SqlWorkspaceResult);
    } catch (error) {
      setSqlError(error instanceof Error ? error.message : 'Could not run this query.');
    } finally {
      setSqlBusy(false);
    }
  };
  const updateConnectionField = (field: string, value: string | boolean) => {
    if (pendingConnectionId) {
      void fetch(`http://localhost:4000/api/connections/${pendingConnectionId}`, { method: 'DELETE' }).catch(() => undefined);
      setPendingConnectionId(null);
    }
    setConnectionForm((current) => ({ ...current, [field]: value, ...(field === 'port' && value === '5432' ? { database: current.database } : {}) }));
    setConnectionResult('');
    setConnectionVerified(false);
  };
  const selectConnectionEngine = (engine: 'postgres' | 'mysql') => {
    if (pendingConnectionId) {
      void fetch(`http://localhost:4000/api/connections/${pendingConnectionId}`, { method: 'DELETE' }).catch(() => undefined);
      setPendingConnectionId(null);
    }
    setConnectionEngine(engine);
    setConnectionForm((current) => ({ ...current, port: engine === 'postgres' ? '5432' : '3306' }));
    setConnectionResult('');
    setConnectionVerified(false);
  };
  const submitConnectionTest = async (event: React.FormEvent) => {
    event.preventDefault(); setConnectionBusy(true); setConnectionResult(''); setConnectionVerified(false);
    try {
      const previousPendingConnectionId = pendingConnectionId;
      const response = await fetch('http://localhost:4000/api/connections/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...connectionForm, port: Number(connectionForm.port), engine: connectionEngine }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Connection test failed');
      setConnectionResult(`Connected successfully · ${payload.serverVersion} · ${payload.latencyMs} ms`);
      setPendingConnectionId(payload.connectionId);
      if (previousPendingConnectionId && previousPendingConnectionId !== payload.connectionId) {
        void fetch(`http://localhost:4000/api/connections/${previousPendingConnectionId}`, { method: 'DELETE' }).catch(() => undefined);
      }
      setConnectionVerified(true);
    } catch (error) { setConnectionResult(error instanceof Error ? error.message : 'Could not reach the local API. Start the backend with npm run dev.'); }
    finally { setConnectionBusy(false); }
  };
  const closeConnectionDialog = () => {
    setShowConnection(false);
    setConnectionForm((current) => ({ ...current, username: '', password: '' }));
    setConnectionResult('');
  };
  const resetLiveDatabase = () => {
    setLiveConnectionId(null);
    setPendingConnectionId(null);
    setConnectionVerified(false);
    setLiveSchema(null);
    setSchemaNotice('');
    setSchemaRefreshTarget(null);
    setLiveRecords(null);
    setSelectedLiveRow(null);
    setSqlResult(null);
    setNodes(initialNodes);
    setEdges(initialEdges);
    setActiveTable('orders');
  };
  const disconnectDatabase = async () => {
    const connectionIds = new Set([liveConnectionId, pendingConnectionId].filter((id): id is string => Boolean(id)));
    for (const connectionId of connectionIds) {
      await fetch(`http://localhost:4000/api/connections/${connectionId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    resetLiveDatabase();
    setPendingConnectionId(null);
    setConnectionVerified(false);
    setSection('schema');
    notify('Database session closed · demo schema restored');
  };
  const refreshSchemaAfterCreate = async (schemaName: string, tableName: string) => {
    if (!liveConnectionId) return;
    try {
      const response = await fetch('http://localhost:4000/api/connections/introspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: liveConnectionId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Schema refresh failed');
      const schema = payload as LiveSchema;
      const graph = makeSchemaGraph(schema);
      setLiveSchema(schema); setNodes(graph.nodes); setEdges(graph.edges);
      const createdTableIsVisible = schema.tables.some((table) => table.schema === schemaName && table.name === tableName);
      setActiveTable(createdTableIsVisible ? schemaTableId(schemaName, tableName) : schema.tables[0] ? schemaTableId(schema.tables[0].schema, schema.tables[0].name) : '');
      setLiveRecords(null); setSqlResult(null); setSqlError(''); setRecordsError(''); setSchemaNotice(''); setSection('schema');
      if (createdTableIsVisible) {
        setSchemaRefreshTarget(null);
        notify(`Created and verified ${schemaName}.${tableName}`);
      } else {
        setSchemaNotice(`Created ${schemaName}.${tableName}, but it is not visible in schema introspection. Refresh schema to verify it.`);
        setSchemaRefreshTarget({ schema: schemaName, table: tableName });
      }
    } catch {
      setSchemaNotice(`Created ${schemaName}.${tableName}, but schema refresh failed. Refresh schema to verify it.`);
      setSchemaRefreshTarget({ schema: schemaName, table: tableName });
    }
  };
  const refreshSchemaAfterColumnChange = async (change: { schema: string; table: string; column: string }) => {
    if (!liveConnectionId) return;
    try {
      const response = await fetch('http://localhost:4000/api/connections/introspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: liveConnectionId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Schema refresh failed');
      const schema = payload as LiveSchema;
      const graph = makeSchemaGraph(schema);
      const updatedTable = schema.tables.find((table) => table.schema === change.schema && table.name === change.table);
      const columnVisible = updatedTable?.columns.some((column) => column.name === change.column) ?? false;
      setLiveSchema(schema); setNodes(graph.nodes); setEdges(graph.edges);
      setActiveTable(updatedTable ? schemaTableId(change.schema, change.table) : schema.tables[0] ? schemaTableId(schema.tables[0].schema, schema.tables[0].name) : '');
      setLiveRecords(null); setSqlResult(null); setSqlError(''); setRecordsError(''); setSection('schema');
      if (columnVisible) { setSchemaNotice(''); setSchemaRefreshTarget(null); notify(`Added ${change.column} to ${change.schema}.${change.table}`); }
      else {
        setSchemaNotice(`Added ${change.column}, but it is not visible in schema introspection. Refresh schema to verify it.`);
        setSchemaRefreshTarget({ schema: change.schema, table: change.table, column: change.column });
      }
    } catch {
      setSchemaNotice(`Added ${change.column} to ${change.schema}.${change.table}, but schema refresh failed. Refresh schema to verify it.`);
      setSchemaRefreshTarget({ schema: change.schema, table: change.table, column: change.column });
      setSection('schema');
    }
  };
  const refreshLiveSchema = async () => {
    if (!liveConnectionId) { setShowConnection(true); return; }
    setSchemaRefreshBusy(true);
    try {
      const response = await fetch('http://localhost:4000/api/connections/introspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: liveConnectionId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Schema refresh failed');
      const schema = payload as LiveSchema;
      const graph = makeSchemaGraph(schema);
      setLiveSchema(schema); setNodes(graph.nodes); setEdges(graph.edges);
      if (!schema.tables.some((table) => schemaTableId(table.schema, table.name) === activeTable)) setActiveTable(schema.tables[0] ? schemaTableId(schema.tables[0].schema, schema.tables[0].name) : '');
      const refreshedTable = schemaRefreshTarget && schema.tables.find((table) => table.schema === schemaRefreshTarget.schema && table.name === schemaRefreshTarget.table);
      const refreshTargetVisible = Boolean(refreshedTable && (!schemaRefreshTarget?.column || refreshedTable.columns.some((column) => column.name === schemaRefreshTarget.column)));
      if (schemaRefreshTarget && !refreshTargetVisible) {
        setSchemaNotice(`Refreshed schema, but ${schemaRefreshTarget.schema}.${schemaRefreshTarget.table}${schemaRefreshTarget.column ? `.${schemaRefreshTarget.column}` : ''} is not visible. Check database privileges or refresh again.`);
      } else {
        setSchemaNotice(''); setSchemaRefreshTarget(null);
      }
    } catch (error) {
      setSchemaNotice(`${schemaNotice.split(';')[0]}; refresh failed: ${error instanceof Error ? error.message : 'could not read database schema'}.`);
    } finally { setSchemaRefreshBusy(false); }
  };
  const openTableDesigner = () => {
    if (!liveConnectionId || !liveSchema) {
      notify('Connect PostgreSQL or MySQL before creating a table.');
      setShowConnection(true);
      return;
    }
    setShowCreateTable(true);
  };
  const openAddColumnReview = () => {
    if (!liveConnectionId || !liveSchema) { notify('Connect PostgreSQL or MySQL before changing a schema.'); setShowConnection(true); return; }
    setShowAddColumnReview(true);
  };
  const inspectSchema = async () => {
    const connectionId = pendingConnectionId ?? liveConnectionId;
    if (!connectionId) {
      setConnectionResult(`Test the ${connectionEngine === 'postgres' ? 'PostgreSQL' : 'MySQL'} connection again to open a workspace session.`);
      setConnectionVerified(false);
      return;
    }
    setConnectionBusy(true);
    setConnectionResult(`Reading visible ${connectionEngine === 'postgres' ? 'PostgreSQL' : 'MySQL'} schema metadata…`);
    try {
      const response = await fetch('http://localhost:4000/api/connections/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (response.status === 410) {
          if (pendingConnectionId) setPendingConnectionId(null);
          else {
            resetLiveDatabase();
            setSection('schema');
          }
          setConnectionVerified(false);
        }
        throw new Error(payload.error ?? 'Schema inspection failed');
      }
      const schema = payload as LiveSchema;
      const graph = makeSchemaGraph(schema);
      setLiveSchema(schema);
      setLiveConnectionId(connectionId);
      setPendingConnectionId(null);
      if (liveConnectionId && liveConnectionId !== connectionId) {
        void fetch(`http://localhost:4000/api/connections/${liveConnectionId}`, { method: 'DELETE' }).catch(() => undefined);
      }
      setLiveRecords(null);
      setSqlResult(null);
      setSqlError('');
      setRecordsError('');
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setActiveTable(schema.tables[0] ? schemaTableId(schema.tables[0].schema, schema.tables[0].name) : '');
      setSchemaNotice('');
      setSchemaRefreshTarget(null);
      setSection('schema');
      closeConnectionDialog();
      notify(`Loaded ${schema.tables.length} ${schema.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'} tables · metadata only`);
    } catch (error) {
      setConnectionResult(error instanceof Error ? error.message : 'Could not inspect this database schema.');
    } finally {
      setConnectionBusy(false);
    }
  };
  const loadLiveRecords = async (schema: string, table: string, page: number, pageSize = 50, sort: LiveRecordSort | null = liveSort) => {
    const requestedSort = liveRecords?.schema === schema && liveRecords.table === table ? sort : null;
    if (!liveConnectionId) {
      setRecordsError('The database session is unavailable. Test the connection again before browsing records.');
      setLiveSort(null);
      setLiveRecords({ schema, table, page, pageSize, hasMore: false, rows: [] });
      setSection('data');
      return;
    }
    setRecordsBusy(true);
    setRecordsError('');
    setSearchText('');
    setSelectedLiveRow(null);
    setLiveSort(requestedSort);
    setLiveRecords({ schema, table, page, pageSize, hasMore: false, rows: [] });
    try {
      const response = await fetch('http://localhost:4000/api/connections/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: liveConnectionId, schema, table, page, pageSize, ...(requestedSort ? { sort: requestedSort } : {}) }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (response.status === 410) {
          resetLiveDatabase();
          setSection('schema');
        }
        throw new Error(payload.error ?? 'Could not load this table page.');
      }
      setLiveRecords({ schema, table, ...payload } as LiveRecordsPage);
      setActiveTable(schemaTableId(schema, table));
      setSection('data');
    } catch (error) {
      setRecordsError(error instanceof Error ? error.message : 'Could not load this table page.');
    } finally {
      setRecordsBusy(false);
    }
  };
  const renderContent = () => {
    if (section === 'schema') return <>
      <div className="page-heading"><div><div className="eyebrow">DATABASE DESIGN</div><h1>Schema designer <span className="beta-tag">BETA</span></h1><p>{liveSchema ? `Browse and create tables in this ${liveSchema.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'} database. Table creation requires SQL review and confirmation.` : 'See how your data connects. Drag tables around to make the structure your own.'}</p></div><div className="heading-actions"><button className="button button-quiet" onClick={() => setSection('sql')}><Code2 size={15}/> Open SQL workspace</button><button className="button button-primary" onClick={openTableDesigner}><Plus size={16}/> New table</button></div></div>
      {schemaNotice && <div className="schema-refresh-alert" role="alert"><span>{schemaNotice}</span><button className="button button-quiet" onClick={() => void refreshLiveSchema()} disabled={schemaRefreshBusy}>{schemaRefreshBusy ? 'Refreshing…' : 'Refresh schema'}</button></div>}
      <div className="schema-toolbar"><div className="schema-crumb"><span className="crumb-icon"><Database size={14}/></span><span>{liveSchema?.database ?? 'commerce_demo'}</span><ChevronRight size={13}/><span>{selectedLiveTable?.schema ?? (liveSchema ? 'All schemas' : 'public')}</span><ChevronRight size={13}/><strong>Schema map</strong></div><div className="toolbar-right"><span className="sync-indicator"><span className="status-dot"/> {liveSchema ? `Live ${liveSchema.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'}` : 'Demo data'}</span>{liveSchema && <><button className="button button-quiet" onClick={() => void refreshLiveSchema()} disabled={schemaRefreshBusy}>{schemaRefreshBusy ? 'Refreshing…' : 'Refresh schema'}</button><button className="button button-quiet" onClick={disconnectDatabase}><X size={13}/> Disconnect</button></>}<span className="toolbar-separator"/><button className="icon-button" title="Fit view" aria-label="Fit schema to view" onClick={() => { void schemaFlow?.fitView({ padding: 0.16 }); }}><Maximize2 size={15}/></button></div></div>
      <div className="schema-canvas"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={(_event, node) => setActiveTable(node.id)} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onInit={(instance) => { setSchemaFlow(instance); window.setTimeout(() => { void instance.fitView({ padding: 0.12 }); }, 120); }} fitView fitViewOptions={{ padding: 0.12 }} minZoom={0.3} maxZoom={1.6}><Background color="#d7dee8" gap={24} size={1}/><Controls showInteractive={false}/></ReactFlow>{liveSchema?.tables.length === 0 && <div className="schema-empty-state"><strong>No visible tables found</strong><span>This account can connect, but no base tables were returned from the accessible schemas.</span></div>}<div className="canvas-legend"><span><KeyRound size={11}/> Primary key</span><span><Link2 size={11}/> Foreign key</span><span><span className="legend-line"/> Relationship</span></div><div className="canvas-tip"><Grip size={13}/> Drag nodes to rearrange</div></div>
      <div className="bottom-inspector"><div className="inspector-title"><div className="table-icon small"><Table2 size={13}/></div><div><strong>{selectedLiveTable ? `${selectedLiveTable.schema}.${selectedLiveTable.name}` : liveSchema ? 'No table selected' : activeTable}</strong><span>{liveSchema ? `${liveSchema.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'} catalog metadata` : 'Selected table · public schema'}</span></div></div><div className="inspector-metrics"><div><span>COLUMNS</span><strong>{selectedLiveTable?.columns.length ?? (liveSchema ? 0 : 4)}</strong></div><div><span>FOREIGN KEYS</span><strong>{liveSchema ? liveForeignKeyCount : activeTable === 'orders' ? 2 : 1}</strong></div><div><span>LAST INSPECTED</span><strong>{liveSchema ? new Date(liveSchema.introspectedAt).toLocaleTimeString() : 'Demo'}</strong></div></div><button className="button button-quiet" onClick={() => selectedLiveTable ? void loadLiveRecords(selectedLiveTable.schema, selectedLiveTable.name, 0) : setSection('data')}><Eye size={14}/> {liveSchema ? 'View live records' : 'View records'} <ArrowRight size={14}/></button></div>
    </>;
    if (section === 'data') return <>
      <div className="page-heading"><div><div className="eyebrow">{liveRecords ? 'LIVE TABLE' : 'EXPLORE YOUR DATA'}</div><h1>{liveRecords ? liveRecords.table : 'Data explorer'}</h1><p>{liveRecords ? `Records from ${liveRecords.schema}.${liveRecords.table}. Showing up to ${liveRecords.pageSize} rows per page.` : 'Inspect records in a familiar grid. This preview uses sample data, not a live database.'}</p></div><div className="heading-actions">{liveRecords ? <><span className="read-only-label"><LockKeyhole size={12}/> {liveSchema?.engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} · {livePrimaryKeyColumns.length ? 'row updates enabled' : 'read only · no primary key'}</span><button className="button button-quiet" onClick={() => setSection('schema')}><GitBranch size={14}/> Back to schema</button></> : <span className="read-only-label"><Eye size={12}/> Demo data · read only</span>}</div></div>
      <div className="data-toolbar"><div className="table-select"><Table2 size={15}/><strong>{liveRecords ? `${liveRecords.schema}.${liveRecords.table}` : activeTable}</strong></div><div className="search-box"><Search size={14}/><input type="search" name={liveRecords ? 'record-search' : 'sample-search'} autoComplete="off" aria-label={liveRecords ? 'Search records on this page' : 'Search sample records'} value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder={liveRecords ? 'Search this page…' : 'Search sample records…'}/></div>{liveRecords && <button className="button button-primary" onClick={() => setShowEditRecord(true)} disabled={!selectedLiveRow || !livePrimaryKeyColumns.length || recordsBusy}><Check size={14}/> Edit selected row</button>}</div>
      {recordsError && liveRecords && <div className="record-alert" role="alert">{recordsError}</div>}
      {recordsBusy && liveRecords && <div className="record-loading" role="status" aria-live="polite">Loading records…</div>}
      <div className="grid-wrap"><div className="ag-theme-quartz custom-grid"><AgGridReact rowData={liveRecords ? liveFilteredRows : demoFilteredRows} columnDefs={(liveRecords ? liveColDefs : colDefs) as any} defaultColDef={{ sortable: true, resizable: true }} onSortChanged={(event) => {
        if (!liveRecords || recordsBusy) return;
        const activeSort = event.api.getColumnState().find((column) => column.sort);
        const nextSort: LiveRecordSort | null = activeSort?.sort ? { column: activeSort.colId, direction: activeSort.sort } : null;
        if (JSON.stringify(nextSort) === JSON.stringify(liveSort)) return;
        void loadLiveRecords(liveRecords.schema, liveRecords.table, 0, liveRecords.pageSize, nextSort);
      }} rowSelection={liveRecords ? { mode: 'singleRow', checkboxes: false, enableClickSelection: true } : undefined} getRowId={(params) => livePrimaryKeyColumns.length ? JSON.stringify(livePrimaryKeyColumns.map((column) => params.data[column.name])) : JSON.stringify(Object.values(params.data))} onSelectionChanged={(event) => setSelectedLiveRow(liveRecords ? event.api.getSelectedRows()[0] ?? null : null)} rowHeight={47} headerHeight={42} animateRows={!liveRecords} suppressCellFocus={true}/></div>{liveRecords?.rows.length === 0 && !recordsBusy && !recordsError && <div className="live-record-empty">This table has no rows.</div>}</div>
      {liveRecords ? <div className="grid-footer live-grid-footer"><span>Page <strong>{liveRecords.page + 1}</strong> · {liveFilteredRows.length} of {liveRecords.rows.length} rows shown{liveSort ? ` · sorted by ${liveSort.column} ${liveSort.direction.toUpperCase()}` : ''}{searchText ? ' · search applies to this page only' : ''}</span><span className="pagination-controls"><label>Rows<select aria-label="Rows per page" value={liveRecords.pageSize} disabled={recordsBusy} onChange={(event) => void loadLiveRecords(liveRecords.schema, liveRecords.table, 0, Number(event.target.value))}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><button className="button button-quiet" disabled={recordsBusy || liveRecords.page === 0} onClick={() => void loadLiveRecords(liveRecords.schema, liveRecords.table, liveRecords.page - 1, liveRecords.pageSize)}>Previous</button><button className="button button-quiet" disabled={recordsBusy || !liveRecords.hasMore} onClick={() => void loadLiveRecords(liveRecords.schema, liveRecords.table, liveRecords.page + 1, liveRecords.pageSize)}>Next</button></span></div> : <div className="grid-footer"><span>Showing <strong>{demoFilteredRows.length}</strong> sample records</span><span>Demo mode · Read only <span className="footer-dot"/></span></div>}
    </>;
    if (section === 'sql') return <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">QUERY EDITOR</div>
          <h1>SQL workspace</h1>
          <p>{liveConnectionId && liveSchema ? 'Run SELECT queries in a read-only transaction. Review a supported ADD COLUMN change separately. Query results are capped at 1,000 rows.' : 'Write SQL here, then preview clearly labeled sample rows. No query is sent until a database is connected.'}</p>
        </div>
        <div className="heading-actions">
          <span className="read-only-label"><LockKeyhole size={12}/> {liveConnectionId && liveSchema ? `${liveSchema.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'} · SELECT mode` : 'Demo connection'}</span>
          {liveConnectionId && liveSchema && <button className="button button-quiet" onClick={openAddColumnReview} disabled={sqlBusy}>Review schema change</button>}
          <button className="button button-primary" onClick={() => void runQuery()} disabled={sqlBusy}>
            <Eye size={14}/>{sqlBusy ? 'Running query…' : liveConnectionId && liveSchema ? 'Run read-only query' : 'Preview demo rows'}
          </button>
        </div>
      </div>
      <div className="sql-layout">
        <div className="editor-panel">
          <div className="editor-tabs">
            <div className="editor-tab active"><FileCode2 size={14}/> query.sql <span className="unsaved-dot"/></div>
            <button className="editor-tab-add" aria-label="Open a sample query" onClick={() => { setSql('SELECT *\nFROM orders\nLIMIT 100;'); setSqlResult(null); setSqlError(''); }}><Plus size={15}/></button>
            <div className="editor-tab-spacer"/>
            <span className="editor-language">{liveSchema ? liveSchema.engine.toUpperCase() : 'SQL'}</span>
          </div>
          <div className="monaco-wrap"><Suspense fallback={<div className="editor-loading" role="status" aria-live="polite">Loading SQL editor…</div>}><Editor height="100%" language="sql" theme="vs" value={sql} onChange={(value) => { setSql(value ?? ''); setSqlResult(null); setSqlError(''); }} options={{ minimap: { enabled: false }, fontSize: 14, fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace', lineNumbers: 'on', padding: { top: 20 }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, wordWrap: 'on', suggestOnTriggerCharacters: true, renderLineHighlight: 'gutter' }}/></Suspense></div>
          <div className="editor-status"><span><span className="status-dot"/> {sqlBusy ? 'Running' : 'Ready'}</span><span>UTF-8</span><span>SQL</span></div>
        </div>
        <div className="results-panel">
          <div className="results-header">
            <div><span className="results-title">Results</span><span className="results-subtitle">{sqlResult ? `${sqlResult.rowCount} rows${sqlResult.source === 'database' ? ` · ${sqlResult.elapsedMs} ms` : ' · demo sample'}` : 'Query output appears here'}</span></div>
          </div>
          {sqlError && <div className="query-error" role="alert">{sqlError}</div>}
          {sqlBusy && <div className="query-loading" role="status" aria-live="polite">Running a read-only query…</div>}
          {sqlResult && <>
            <div className={sqlResult.source === 'database' ? 'result-success' : 'result-preview'}>
              {sqlResult.source === 'database' ? <LockKeyhole size={14}/> : <Eye size={14}/>}
              {sqlResult.source === 'database' ? `Read-only database result${sqlResult.truncated ? ' · showing first 1,000 rows' : ''}` : 'Demo sample rows · SQL was not sent'}
            </div>
            <div className="sql-results-grid ag-theme-quartz custom-grid">
              <AgGridReact rowData={sqlResult.rows} columnDefs={sqlColDefs as any} defaultColDef={{ sortable: true, resizable: true, minWidth: 110 }} rowHeight={42} headerHeight={40} suppressCellFocus={true}/>
            </div>
          </>}
          {!sqlResult && !sqlError && !sqlBusy && <div className="empty-results">
            <div className="empty-result-icon"><TerminalSquare size={21}/></div>
            <strong>{liveConnectionId ? 'Ready to run a read-only query' : 'Preview sample rows'}</strong>
            <span>{liveConnectionId ? 'Queries accept one read-only SELECT. Review schema change supports one ALTER TABLE … ADD COLUMN operation.' : 'Connect a database to run SQL. The demo preview does not execute this editor text.'}</span>
          </div>}
        </div>
      </div>
    </>;
    if (section === 'learning') return <>
      <div className="page-heading"><div><div className="eyebrow">LEARN BY DOING</div><h1>Learn databases</h1><p>Build database intuition with visual, hands-on lessons. Learning modules are coming soon.</p></div><div className="heading-actions"><span className="read-only-label"><GraduationCap size={14}/> Beginner friendly</span></div></div><div className="learning-hero"><div className="learning-copy"><span className="learning-kicker"><Sparkles size={13}/> YOUR DATABASE JOURNEY</span><h2>Understand databases.<br/><span>Don't just memorize them.</span></h2><p>Explore relationships, experiment with SQL, and see how the pieces fit together — at your own pace.</p></div><div className="learning-graphic"><div className="learning-orbit orbit-one"/><div className="learning-orbit orbit-two"/><div className="learning-core"><Database size={38}/></div><div className="orbit-chip chip-one"><KeyRound size={15}/></div><div className="orbit-chip chip-two"><Link2 size={15}/></div><div className="orbit-chip chip-three"><Braces size={15}/></div></div></div><div className="lesson-grid"><div className="lesson-card"><div className="lesson-icon violet"><Table2 size={18}/></div><span className="lesson-level">LESSON 01 · 8 MIN</span><h3>Tables & columns</h3><p>Understand how databases organize information into structured records.</p><div className="lesson-progress"><span style={{ width: '0%' }}/></div><span className="lesson-bottom">Not started <ArrowRight size={13}/></span></div><div className="lesson-card"><div className="lesson-icon blue"><Link2 size={18}/></div><span className="lesson-level">LESSON 02 · 12 MIN</span><h3>Keys & relationships</h3><p>Connect tables and understand primary and foreign keys visually.</p><div className="lesson-progress"><span style={{ width: '0%' }}/></div><span className="lesson-bottom">Not started <ArrowRight size={13}/></span></div><div className="lesson-card"><div className="lesson-icon mint"><TerminalSquare size={18}/></div><span className="lesson-level">LESSON 03 · 15 MIN</span><h3>Your first SQL query</h3><p>Learn SELECT, WHERE, and ORDER BY using a safe demo database.</p><div className="lesson-progress"><span style={{ width: '0%' }}/></div><span className="lesson-bottom">Not started <ArrowRight size={13}/></span></div></div>
    </>;
    return <>
      <div className="page-heading"><div><div className="eyebrow">DATABASE WORKSPACE</div><h1>Explore your data</h1><p>Open the sample workspace or test a connection to your own database.</p></div><div className="heading-actions"><button className="button button-primary" onClick={() => setShowConnection(true)}><Plus size={15}/> Add connection</button></div></div>
      <div className="overview-workspace"><section className="overview-environment"><span className="overview-section-label">ACTIVE ENVIRONMENT</span><div className="overview-name"><Database size={19}/><h2>{liveSchema?.database ?? 'commerce_demo'}</h2><span className="demo-badge">{liveSchema ? liveSchema.engine.toUpperCase() : 'DEMO'}</span></div><p>{liveSchema ? 'Live schema, records, and read-only SQL queries are available. Data-changing SQL remains disabled.' : 'Read-only sample data for exploring the interface.'}</p><div className="overview-details"><span><strong>{liveSchema?.tables.length ?? initialNodes.length}</strong> {liveSchema ? 'visible tables' : 'tables'}</span><span><strong>{liveSchema ? edges.length : initialEdges.length}</strong> relationships</span></div><div className="overview-actions"><button className="button button-primary" onClick={() => setSection('schema')}><GitBranch size={15}/> Open schema designer</button><button className="button button-quiet" onClick={() => setSection('data')}><Table2 size={15}/> Browse sample records</button></div></section><section className="overview-connect"><span className="overview-section-label">YOUR DATABASE</span><h2>{liveSchema ? 'Inspect another schema' : 'Connect PostgreSQL or MySQL'}</h2><p>{liveSchema ? 'The API keeps credentials in an expiring in-memory session; no profile is saved.' : 'Connect through the local API to inspect schemas and browse read-only records.'}</p><button className="text-button" onClick={() => setShowConnection(true)}>{liveSchema ? 'Inspect database' : 'Set up a connection'} <ArrowRight size={14}/></button></section></div>
    </>;
  };

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a><aside className={`sidebar ${sidebarOpen ? '' : 'sidebar-collapsed'}`}><div className="brand-row"><div className="brand-mark"><BrandMark/></div>{sidebarOpen && <div className="brand-copy"><strong>DBFLOW</strong><small>DATABASE WORKSPACE</small></div>}<button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle sidebar" aria-label="Toggle sidebar" aria-expanded={sidebarOpen}><PanelLeftClose size={16}/></button></div>
      {sidebarOpen && <div className="workspace-switcher"><div className="workspace-avatar">C</div><div className="workspace-name"><strong>Commerce workspace</strong><span>Personal workspace</span></div><ChevronDown size={14}/></div>}
      <div className="sidebar-nav">
        {['WORKSPACE', 'LEARN'].map((group) => (
          <div className="nav-group" key={group}>
            <div className="nav-group-label">{sidebarOpen ? group : '···'}</div>
            {navItems.filter((item) => item.group === group).map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.key} className={`nav-item ${section === item.key ? 'active' : ''}`} onClick={() => setSection(item.key)} title={!sidebarOpen ? item.label : undefined}>
                  <Icon size={18} />
                  {sidebarOpen && <span className="nav-label-wrap"><span>{item.label}</span>{item.key === 'learning' && <span className="nav-new">NEW</span>}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {sidebarOpen && <div className="sidebar-connections"><div className="connection-heading"><span>CONNECTIONS</span><button onClick={() => setShowConnection(true)} title="Add connection" aria-label="Add connection"><Plus size={14}/></button></div><button className="connection-item" onClick={() => setShowConnection(true)}><span className="connection-db-icon"><Database size={14}/></span><span className="connection-info"><strong>{liveSchema?.database ?? 'commerce_demo'}</strong><small><i/> {liveSchema ? `Connected · ${liveSchema.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'}` : 'Demo database'}</small></span><span className="demo-badge">{liveSchema ? 'PG' : 'DEMO'}</span></button><button className="add-connection" onClick={() => setShowConnection(true)}><Plus size={14}/> Add connection</button></div>}
      <div className="sidebar-bottom"><button className="nav-item" onClick={() => notify('Settings will be available as the app grows.')}><Settings2 size={17}/>{sidebarOpen && <span>Settings</span>}</button><button className="nav-item" onClick={() => notify('Help documentation is being prepared.')}><CircleHelp size={17}/>{sidebarOpen && <span>Help & feedback</span>}</button>{sidebarOpen && <div className="user-card"><div className="user-avatar">M</div><div className="user-copy"><strong>My workspace</strong><span>Free plan · Local demo</span></div><MoreHorizontal size={16}/></div>}</div>
    </aside>
    <main id="main-content" className="main-area" tabIndex={-1}><header className="topbar"><div className="topbar-left"><button className="mobile-menu" aria-label={sidebarOpen ? 'Hide navigation' : 'Show navigation'} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={18}/></button><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13}/><strong>{title}</strong></div></div><div className="topbar-right"><div className="connection-status"><span className="status-dot"/><span>{liveSchema ? `${liveSchema.engine} · ${liveSchema.database}` : 'Demo environment'}</span><ChevronDown size={12}/></div><button className="top-icon" onClick={() => notify('Keyboard shortcuts are coming soon.')} title="Shortcuts" aria-label="Shortcuts"><Command size={16}/></button><button className="top-icon" onClick={() => notify('Help center coming soon.')} title="Help" aria-label="Help"><HelpCircle size={16}/></button><div className="top-avatar">M</div></div></header><div className={`page-content ${section === 'schema' ? 'schema-page' : ''}`}>{renderContent()}<footer className="app-footer"><span><span className="footer-brand-dot"/> DBFLOW <span className="footer-version">v0.1.0</span></span><span>Built for clarity <span className="footer-heart">✳</span></span></footer></div></main>
    {showConnection && <div className="modal-backdrop" onClick={closeConnectionDialog}><div className="connection-modal" role="dialog" aria-modal="true" aria-labelledby="connect-dialog-title" aria-describedby="connect-dialog-description" onClick={(e) => e.stopPropagation()}><div className="modal-heading"><div className="modal-icon"><Database size={19}/></div><button className="icon-button" aria-label="Close connection dialog" onClick={closeConnectionDialog}><X size={17}/></button></div><h2 id="connect-dialog-title">Connect a database</h2><p id="connect-dialog-description">Credentials are sent to the local API to open an expiring in-memory session; the form fields clear when this dialog closes.</p><div className="engine-toggle"><button type="button" className={connectionEngine === 'postgres' ? 'selected' : ''} aria-pressed={connectionEngine === 'postgres'} onClick={() => selectConnectionEngine('postgres')}>PostgreSQL</button><button type="button" className={connectionEngine === 'mysql' ? 'selected' : ''} aria-pressed={connectionEngine === 'mysql'} onClick={() => selectConnectionEngine('mysql')}>MySQL</button></div><form className="connection-form" onSubmit={submitConnectionTest}><label>Host<input required value={connectionForm.host} onChange={(e) => updateConnectionField('host', e.target.value)} placeholder="localhost"/></label><div className="form-two-col"><label>Port<input required type="number" min="1" max="65535" value={connectionForm.port} onChange={(e) => updateConnectionField('port', e.target.value)}/></label><label>Database<input required value={connectionForm.database} onChange={(e) => updateConnectionField('database', e.target.value)} placeholder="database_name"/></label></div><label>Username<input required value={connectionForm.username} onChange={(e) => updateConnectionField('username', e.target.value)} placeholder="database user"/></label><label>Password<input type="password" value={connectionForm.password} onChange={(e) => updateConnectionField('password', e.target.value)} placeholder="Password (if required)" autoComplete="new-password"/></label><label className="ssl-checkbox"><input type="checkbox" checked={connectionForm.ssl} onChange={(e) => updateConnectionField('ssl', e.target.checked)}/> Require SSL with certificate validation</label>{connectionResult && <div className={`connection-result ${connectionResult.startsWith('Connected') ? 'success' : connectionResult.startsWith('Reading') ? 'pending' : 'error'}`} role={connectionResult.startsWith('Connected') || connectionResult.startsWith('Reading') ? 'status' : 'alert'} aria-live="polite">{connectionResult.startsWith('Connected') ? <Check size={14}/> : connectionResult.startsWith('Reading') ? <Clock3 size={14}/> : <CircleHelp size={14}/>}<span>{connectionResult}</span></div>}<div className="modal-note"><ShieldCheck size={15}/><span>Local development only. Browsing is read-only. Credentials remain in the API memory pool for up to 15 idle minutes; Disconnect closes the session. The form clears when this dialog closes.</span></div><button className="button button-primary full-button" type="submit" disabled={connectionBusy}>{connectionBusy ? (connectionResult.startsWith('Reading') ? 'Inspecting schema…' : 'Testing connection…') : 'Test connection'} <ArrowRight size={14}/></button>{connectionVerified && (pendingConnectionId || liveConnectionId) && <button className="button button-quiet full-button" type="button" onClick={inspectSchema} disabled={connectionBusy}>{connectionBusy ? 'Inspecting schema…' : pendingConnectionId ? `Inspect ${connectionEngine === 'postgres' ? 'PostgreSQL' : 'MySQL'} schema` : `Refresh ${connectionEngine === 'postgres' ? 'PostgreSQL' : 'MySQL'} schema`} <Database size={14}/></button>}</form></div></div>}
    {showEditRecord && liveConnectionId && liveRecords && selectedLiveRow && liveRecordTable && <EditRecordDialog connectionId={liveConnectionId} schema={liveRecords.schema} table={liveRecords.table} row={selectedLiveRow} columns={liveRecordTable.columns} onClose={() => setShowEditRecord(false)} onSaved={async () => { await loadLiveRecords(liveRecords.schema, liveRecords.table, liveRecords.page, liveRecords.pageSize); notify('Row saved to the database'); }} />}
    {showCreateTable && liveConnectionId && liveSchema && <CreateTableDialog connectionId={liveConnectionId} engine={liveSchema.engine} initialSchema={liveSchema.engine === 'mysql' ? liveSchema.database : selectedLiveTable?.schema ?? liveSchema.tables[0]?.schema ?? 'public'} onClose={() => setShowCreateTable(false)} onCreated={refreshSchemaAfterCreate}/>}
    {showAddColumnReview && liveConnectionId && <ReviewAddColumnDialog connectionId={liveConnectionId} sql={sql} onClose={() => setShowAddColumnReview(false)} onExecuted={refreshSchemaAfterColumnChange}/>}
    {toast && <div className="toast" role="status" aria-live="polite"><Check size={15}/>{toast}</div>}
  </div>;
}
export default App;
