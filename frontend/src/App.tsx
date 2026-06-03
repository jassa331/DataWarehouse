import { useState, useEffect, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ColumnSchema {
  ordinal: number;
  name: string;
  dataType: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  defaultVal: string | null;
  isIdentity: boolean;
  isPrimaryKey: boolean;
  fkTable: string | null;
  fkColumn: string | null;
}

interface IndexInfo {
  indexName: string;
  indexType: string;
  isUnique: boolean;
  isPk: boolean;
  columns: string;
}

interface IncomingFk {
  fromTable: string;
  fromColumn: string;
  toColumn: string;
}

interface TableSchema {
  tableName: string;
  rowCount: number;
  columns: ColumnSchema[];
  indexes: IndexInfo[];
  incomingFks: IncomingFk[];
}

interface TableData {
  totalRows: number;
  page: number;
  pageSize: number;
  columns: string[];
  rows: Record<string, unknown>[];
}

interface AuditLog {
  id: number;
  tableName: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE' | string;
  recordId: string | number | null;
  oldValues: string | null;
  newValues: string | null;
  changedBy: string | null;
  changedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function typeLabel(col: ColumnSchema): string {
  const t = col.dataType.toLowerCase();
  if (['varchar', 'nvarchar', 'char', 'nchar'].includes(t)) {
    const len = col.maxLength === -1 ? 'MAX' : col.maxLength ?? '?';
    return `${col.dataType}(${len})`;
  }
  if (['decimal', 'numeric'].includes(t) && col.precision != null)
    return `${col.dataType}(${col.precision},${col.scale ?? 0})`;
  return col.dataType;
}

const TYPE_COLOR: Record<string, string> = {
  int: 'bg-blue-900/70 text-blue-300 border-blue-700',
  bigint: 'bg-blue-900/70 text-blue-300 border-blue-700',
  smallint: 'bg-blue-900/70 text-blue-300 border-blue-700',
  tinyint: 'bg-blue-900/70 text-blue-300 border-blue-700',
  decimal: 'bg-cyan-900/70 text-cyan-300 border-cyan-700',
  numeric: 'bg-cyan-900/70 text-cyan-300 border-cyan-700',
  float: 'bg-cyan-900/70 text-cyan-300 border-cyan-700',
  real: 'bg-cyan-900/70 text-cyan-300 border-cyan-700',
  money: 'bg-cyan-900/70 text-cyan-300 border-cyan-700',
  varchar: 'bg-emerald-900/70 text-emerald-300 border-emerald-700',
  nvarchar: 'bg-emerald-900/70 text-emerald-300 border-emerald-700',
  char: 'bg-emerald-900/70 text-emerald-300 border-emerald-700',
  nchar: 'bg-emerald-900/70 text-emerald-300 border-emerald-700',
  text: 'bg-emerald-900/70 text-emerald-300 border-emerald-700',
  ntext: 'bg-emerald-900/70 text-emerald-300 border-emerald-700',
  datetime: 'bg-amber-900/70 text-amber-300 border-amber-700',
  datetime2: 'bg-amber-900/70 text-amber-300 border-amber-700',
  date: 'bg-amber-900/70 text-amber-300 border-amber-700',
  time: 'bg-amber-900/70 text-amber-300 border-amber-700',
  bit: 'bg-purple-900/70 text-purple-300 border-purple-700',
  uniqueidentifier: 'bg-pink-900/70 text-pink-300 border-pink-700',
  image: 'bg-gray-700/70 text-gray-300 border-gray-600',
  varbinary: 'bg-gray-700/70 text-gray-300 border-gray-600',
};
function typeColor(dt: string) { return TYPE_COLOR[dt.toLowerCase()] ?? 'bg-gray-700/70 text-gray-300 border-gray-600'; }

// ── Sub-components ────────────────────────────────────────────────────────────

function Spinner({ sm }: { sm?: boolean }) {
  return (
    <svg className={`animate-spin ${sm ? 'h-4 w-4' : 'h-5 w-5'} text-indigo-400`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

function PkIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-yellow-400 shrink-0" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12.65 10A6 6 0 1 0 17 17h5v-2h-2v-2h-2v-2h-2.35A5.97 5.97 0 0 0 12.65 10zM7 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>
    </svg>
  );
}

function FkIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-sky-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 0 0-5.656 0l-4 4a4 4 0 1 0 5.656 5.656l1.102-1.101M10.172 13.828a4 4 0 0 0 5.656 0l4-4a4 4 0 0 0-5.656-5.656l-1.1 1.1"/>
    </svg>
  );
}

function IdentityIcon() {
  return (
    <span className="inline-block px-1 py-0 rounded text-[10px] font-bold bg-violet-800 text-violet-200 border border-violet-600 leading-tight" title="Identity / Auto-increment">
      ID
    </span>
  );
}

function NullBadge({ nullable }: { nullable: boolean }) {
  return nullable
    ? <span className="text-[10px] px-1.5 py-0 rounded border border-gray-600 text-gray-500 font-mono leading-tight">NULL</span>
    : <span className="text-[10px] px-1.5 py-0 rounded border border-red-800 text-red-400 font-mono leading-tight">NOT NULL</span>;
}

// ── Auth Helper ───────────────────────────────────────────────────────────────

const DAILY_NEEDS_URL = 'https://daily-needs.runasp.net';

function getToken(): string | null {
  // Check URL query param first (e.g., redirected from DailyNeeds with ?token=xxx)
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    localStorage.setItem('jwt_token', urlToken);
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
    return urlToken;
  }
  return localStorage.getItem('jwt_token');
}

function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('jwt_token');
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
    },
  }).then(res => {
    if (res.status === 401) {
      localStorage.removeItem('jwt_token');
      window.location.href = DAILY_NEEDS_URL;
    }
    return res;
  });
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      window.location.href = DAILY_NEEDS_URL;
      return;
    }
    setAuthenticated(true);
  }, []);

  // Sidebar
  const [tables, setTables] = useState<string[]>([]);
  const [tablesLoading, setTablesLoading] = useState(true);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Active table
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [tab, setTab] = useState<'schema' | 'data'>('schema');

  // Schema
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [selectedCol, setSelectedCol] = useState<ColumnSchema | null>(null);

  // Data
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // Audit Logs
  const [view, setView] = useState<'tables' | 'audit'>('tables');
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditAction, setAuditAction] = useState('');
  const [auditTable, setAuditTable] = useState('');
  const [expandedLog, setExpandedLog] = useState<number | null>(null);
  const auditPageSize = 30;

  // Load table list
  useEffect(() => {
      authFetch('https://dailyneedswarehouse.runasp.net/api/tables')
      .then(r => r.json())
      .then((d: string[]) => { setTables(d); setTablesLoading(false); })
      .catch(e => { setTablesError(String(e)); setTablesLoading(false); });
  }, []);

  // Load schema
  const loadSchema = useCallback(async (name: string) => {
    setSchemaLoading(true);
    setSchemaError(null);
    setSelectedCol(null);
    try {
        const res = await authFetch(`https://dailyneedswarehouse.runasp.net/api/tables/${encodeURIComponent(name)}/schema`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSchema(await res.json());
    } catch (e) { setSchemaError(String(e)); }
    finally { setSchemaLoading(false); }
  }, []);

  // Load data
  const loadData = useCallback(async (name: string, pg: number) => {
    setDataLoading(true);
    setDataError(null);
    try {
        const res = await authFetch(`https://dailyneedswarehouse.runasp.net/api/tables/${encodeURIComponent(name)}?page=${pg}&pageSize=${pageSize}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTableData(await res.json());
    } catch (e) { setDataError(String(e)); }
    finally { setDataLoading(false); }
  }, [pageSize]);

  const handleSelectTable = (name: string) => {
    setView('tables');
    setActiveTable(name);
    setTab('schema');
    setSchema(null);
    setTableData(null);
    setPage(1);
    setSchemaError(null);
    setDataError(null);
    loadSchema(name);
  };

  const loadAuditLogs = useCallback(async (pg: number, action: string, tableName: string) => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const params = new URLSearchParams({ page: String(pg), pageSize: String(auditPageSize) });
      if (action) params.set('action', action);
      if (tableName) params.set('tableName', tableName);
        const res = await authFetch(`https://dailyneedswarehouse.runasp.net/api/auditlogs?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAuditLogs(data.logs);
      setAuditTotal(data.totalRows);
    } catch (e) { setAuditError(String(e)); }
    finally { setAuditLoading(false); }
  }, [auditPageSize]);

  const handleOpenAudit = () => {
    setView('audit');
    setActiveTable(null);
    setAuditPage(1);
    setAuditAction('');
    setAuditTable('');
    setExpandedLog(null);
    loadAuditLogs(1, '', '');
  };

  useEffect(() => {
    if (view === 'audit') loadAuditLogs(auditPage, auditAction, auditTable);
  }, [auditPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // When switching to data tab, load if not already loaded
  useEffect(() => {
    if (tab === 'data' && activeTable && !tableData && !dataLoading)
      loadData(activeTable, page);
  }, [tab, activeTable, tableData, dataLoading, page, loadData]);

  useEffect(() => {
    if (tab === 'data' && activeTable) loadData(activeTable, page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = tableData ? Math.ceil(tableData.totalRows / pageSize) : 1;
  const filteredTables = tables.filter(t => t.toLowerCase().includes(search.toLowerCase()));

  if (!authenticated) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
        <div className="animate-spin h-8 w-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950 text-gray-100 font-sans">

      {/* ══ SIDEBAR ══════════════════════════════════════════════════════════ */}
      <aside className="w-60 shrink-0 flex flex-col border-r border-gray-800 bg-gray-900/80">

        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-gray-800">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0 shadow-lg">
            <svg viewBox="0 0 24 24" className="w-5 h-5 text-white" fill="currentColor">
              <path d="M12 2C6.48 2 2 4.69 2 8v8c0 3.31 4.48 6 10 6s10-2.69 10-6V8c0-3.31-4.48-6-10-6zm0 2c4.41 0 8 2.24 8 5s-3.59 5-8 5-8-2.24-8-5 3.59-5 8-5zM4 13.54C5.56 14.99 8.59 16 12 16s6.44-1.01 8-2.46V14c0 2.76-3.59 5-8 5s-8-2.24-8-5v-.46z"/>
            </svg>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-white leading-tight truncate">DataWarehouse</div>
            <div className="text-[11px] text-indigo-400 font-mono truncate">db53357</div>
          </div>
        </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                  {/* Back to Admin Settings Button */}
                  <a
                      href="https://daily-needs.runasp.net/admin/settings"
                      className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 active:bg-gray-100 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-650 dark:hover:bg-gray-750 dark:active:bg-gray-700 rounded-lg shadow-sm transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                  >
                      Admin Settings
                  </a>         
              </div>
        {/* Search */}
        <div className="px-3 py-3 border-b border-gray-800">
          <div className="relative">
            <svg className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-gray-500 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Search tables…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Table list */}
        <div className="flex-1 overflow-y-auto py-1">
          {tablesLoading && (
            <div className="flex items-center justify-center py-10 gap-2 text-gray-500 text-sm"><Spinner sm /> Loading…</div>
          )}
          {tablesError && (
            <div className="mx-3 mt-3 p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-xs">{tablesError}</div>
          )}
          {!tablesLoading && filteredTables.length === 0 && !tablesError && (
            <div className="px-4 py-6 text-gray-500 text-sm text-center">No tables found</div>
          )}
          {filteredTables.map(t => (
            <button
              key={t}
              onClick={() => handleSelectTable(t)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-all rounded-none
                ${activeTable === t
                  ? 'bg-indigo-600/90 text-white font-medium border-l-2 border-indigo-400'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100 border-l-2 border-transparent'}`}
            >
              <svg className="w-3.5 h-3.5 shrink-0 opacity-50" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 3h18v4H3zm0 5h18v4H3zm0 5h18v4H3zm0 5h18v2H3z"/>
              </svg>
              <span className="truncate text-xs font-mono">{t}</span>
            </button>
          ))}
        </div>

        <div className="px-4 py-2.5 border-t border-gray-800 text-[11px] text-gray-600 font-mono">
          {tables.length} tables · daily-needs.runasp.net
        </div>

        {/* Audit Logs nav */}
        <button
          onClick={handleOpenAudit}
          className={`flex items-center gap-2.5 px-4 py-3 border-t border-gray-800 text-sm font-semibold transition-colors w-full
            ${view === 'audit' ? 'bg-amber-600/20 text-amber-300 border-l-2 border-amber-400' : 'text-gray-400 hover:bg-gray-800 hover:text-amber-300'}`}
        >
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          Audit Logs
        </button>
      </aside>

      {/* ══ MAIN ═════════════════════════════════════════════════════════════ */}
      <main className="flex-1 flex flex-col overflow-hidden">

        {/* ── Top bar ── */}
        <header className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-gray-800 bg-gray-900/60 backdrop-blur">
          {view === 'audit' ? (
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-amber-500/20 border border-amber-600/40 flex items-center justify-center">
                <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
              </div>
              <div>
                <h1 className="text-base font-bold text-white leading-tight">Audit Logs</h1>
                <p className="text-[11px] text-gray-400 font-mono">{auditTotal.toLocaleString()} records · AuditLogs</p>
              </div>
            </div>
          ) : activeTable ? (
            <div className="flex items-center gap-4 min-w-0">
              <div className="min-w-0">
                <h1 className="text-base font-bold text-white font-mono leading-tight">{activeTable}</h1>
                {schema && (
                  <p className="text-[11px] text-gray-400 mt-0.5 font-mono">
                    {schema.rowCount.toLocaleString()} rows · {schema.columns.length} columns · {schema.indexes.length} indexes
                  </p>
                )}
              </div>
              <div className="flex gap-1 bg-gray-800 rounded-lg p-1 shrink-0">
                {(['schema', 'data'] as const).map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    className={`px-4 py-1.5 rounded-md text-xs font-semibold transition-colors capitalize
                      ${tab === t ? 'bg-indigo-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}>
                    {t === 'schema' ? '🗂 Schema' : '📊 Data'}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <h1 className="text-base font-bold text-gray-500">Select a table from the sidebar</h1>
          )}

          {view === 'audit' && (
            <button onClick={() => loadAuditLogs(auditPage, auditAction, auditTable)} disabled={auditLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-xs font-medium transition-colors shrink-0">
              {auditLoading ? <Spinner sm /> : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582M20 20v-5h-.581M5.635 19A9 9 0 1 1 19 7.364" />
                </svg>
              )}
              Refresh
            </button>
          )}
          {view === 'tables' && activeTable && (
            <button onClick={() => { if (tab === 'schema') loadSchema(activeTable!); else loadData(activeTable!, page); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium transition-colors shrink-0">
              {(schemaLoading || dataLoading) ? <Spinner sm /> : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582M20 20v-5h-.581M5.635 19A9 9 0 1 1 19 7.364" />
                </svg>
              )}
              Refresh
            </button>
          )}
        </header>

        {/* ── Content ── */}
        <div className="flex-1 flex overflow-hidden">

          {/* ══ AUDIT LOGS VIEW ══ */}
          {view === 'audit' && (
            <div className="flex-1 flex flex-col overflow-hidden">

              {/* Filter bar */}
              <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-gray-800 bg-gray-900/40">
                <select
                  value={auditAction}
                  onChange={e => { setAuditAction(e.target.value); setAuditPage(1); loadAuditLogs(1, e.target.value, auditTable); }}
                  className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="">All Actions</option>
                  <option value="INSERT">INSERT</option>
                  <option value="UPDATE">UPDATE</option>
                  <option value="DELETE">DELETE</option>
                </select>
                <select
                  value={auditTable}
                  onChange={e => { setAuditTable(e.target.value); setAuditPage(1); loadAuditLogs(1, auditAction, e.target.value); }}
                  className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="">All Tables</option>
                  {tables.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                {(auditAction || auditTable) && (
                  <button onClick={() => { setAuditAction(''); setAuditTable(''); setAuditPage(1); loadAuditLogs(1, '', ''); }}
                    className="text-xs text-gray-500 hover:text-gray-200 flex items-center gap-1">
                    ✕ Clear filters
                  </button>
                )}
                <div className="ml-auto text-xs text-gray-500 font-mono">{auditTotal.toLocaleString()} entries</div>
              </div>

              {/* Log list */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {auditLoading && (
                  <div className="space-y-2">
                    {[...Array(6)].map((_, i) => (
                      <div key={i} className="h-16 rounded-xl bg-gray-800/60 animate-pulse" style={{ opacity: 1 - i * 0.12 }} />
                    ))}
                  </div>
                )}
                {auditError && (
                  <div className="p-4 rounded-xl bg-red-900/30 border border-red-700 text-red-300 text-sm">⚠ {auditError}</div>
                )}
                {!auditLoading && auditLogs.length === 0 && !auditError && (
                  <div className="flex flex-col items-center justify-center py-20 text-gray-600 gap-2">
                    <p className="text-lg font-medium">No audit logs found</p>
                  </div>
                )}
                {!auditLoading && auditLogs.map(log => {
                  const isExpanded = expandedLog === log.id;
                  const actionColors: Record<string, string> = {
                    INSERT: 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400',
                    UPDATE: 'bg-blue-500/10 border-blue-500/40 text-blue-400',
                    DELETE: 'bg-red-500/10 border-red-500/40 text-red-400',
                  };
                  const actionDot: Record<string, string> = {
                    INSERT: 'bg-emerald-400',
                    UPDATE: 'bg-blue-400',
                    DELETE: 'bg-red-400',
                  };
                  const aColor = actionColors[log.action] ?? 'bg-gray-700 border-gray-600 text-gray-300';
                  const aDot   = actionDot[log.action]   ?? 'bg-gray-400';

                  let oldObj: Record<string, unknown> | null = null;
                  let newObj: Record<string, unknown> | null = null;
                  try { if (log.oldValues) oldObj = JSON.parse(log.oldValues); } catch { /**/ }
                  try { if (log.newValues) newObj = JSON.parse(log.newValues); } catch { /**/ }

                  const changedKeys = newObj && oldObj
                    ? Object.keys(newObj).filter(k => JSON.stringify(newObj![k]) !== JSON.stringify(oldObj![k]))
                    : newObj ? Object.keys(newObj) : [];

                  return (
                    <div key={log.id}
                      className={`rounded-xl border transition-all ${isExpanded ? 'border-amber-600/50 bg-gray-900' : 'border-gray-800 bg-gray-900/60 hover:border-gray-700'}`}>

                      {/* Header row */}
                      <button
                        className="w-full flex items-center gap-3 px-4 py-3 text-left"
                        onClick={() => setExpandedLog(isExpanded ? null : log.id)}
                      >
                        {/* Action badge */}
                        <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold shrink-0 ${aColor}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${aDot}`} />
                          {log.action}
                        </span>

                        {/* Table name */}
                        <span className="font-mono text-sm text-indigo-300 font-semibold shrink-0">{log.tableName}</span>

                        {/* Record ID */}
                        {log.recordId != null && (
                          <span className="font-mono text-xs text-gray-500 shrink-0">
                            #<span className="text-gray-300">{String(log.recordId)}</span>
                          </span>
                        )}

                        {/* Changed fields preview */}
                        {changedKeys.length > 0 && (
                          <div className="flex gap-1 flex-wrap min-w-0 flex-1">
                            {changedKeys.slice(0, 4).map(k => (
                              <span key={k} className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-[10px] font-mono text-gray-400">{k}</span>
                            ))}
                            {changedKeys.length > 4 && (
                              <span className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-[10px] text-gray-500">+{changedKeys.length - 4} more</span>
                            )}
                          </div>
                        )}

                        <div className="ml-auto flex items-center gap-3 shrink-0">
                          {/* Changed by */}
                          {log.changedBy && (
                            <span className="text-xs text-gray-500 font-mono hidden sm:block">{log.changedBy}</span>
                          )}
                          {/* Timestamp */}
                          <span className="text-[11px] text-gray-500 font-mono">
                            {new Date(log.changedAt).toLocaleString()}
                          </span>
                          {/* Chevron */}
                          <svg className={`w-4 h-4 text-gray-600 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </button>

                      {/* Expanded diff */}
                      {isExpanded && (
                        <div className="border-t border-gray-800 px-4 pb-4 pt-3 grid grid-cols-1 md:grid-cols-2 gap-3">

                          {/* Meta info */}
                          <div className="md:col-span-2 flex flex-wrap gap-4 text-xs mb-1">
                            <div><span className="text-gray-600">Log ID </span><span className="font-mono text-gray-300">{log.id}</span></div>
                            <div><span className="text-gray-600">Table </span><span className="font-mono text-indigo-300">{log.tableName}</span></div>
                            {log.recordId != null && <div><span className="text-gray-600">Record </span><span className="font-mono text-gray-300">#{String(log.recordId)}</span></div>}
                            {log.changedBy && <div><span className="text-gray-600">By </span><span className="font-mono text-gray-300">{log.changedBy}</span></div>}
                            <div><span className="text-gray-600">At </span><span className="font-mono text-gray-300">{new Date(log.changedAt).toLocaleString()}</span></div>
                          </div>

                          {/* OLD VALUES */}
                          {(oldObj || log.oldValues) && (
                            <div>
                              <div className="text-[10px] font-semibold text-red-400 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Before
                              </div>
                              <div className="rounded-lg bg-red-950/20 border border-red-900/40 p-3 space-y-1.5">
                                {oldObj
                                  ? Object.entries(oldObj).map(([k, v]) => (
                                      <div key={k} className={`flex gap-2 text-xs rounded px-2 py-1
                                        ${newObj && JSON.stringify(newObj[k]) !== JSON.stringify(v) ? 'bg-red-900/30' : ''}`}>
                                        <span className="text-gray-500 font-mono w-32 shrink-0 truncate">{k}</span>
                                        <span className="text-red-300 font-mono break-all">{v === null ? <span className="text-gray-600 italic">NULL</span> : String(v)}</span>
                                      </div>
                                    ))
                                  : <pre className="text-xs text-gray-400 whitespace-pre-wrap break-all">{log.oldValues}</pre>
                                }
                              </div>
                            </div>
                          )}

                          {/* NEW VALUES */}
                          {(newObj || log.newValues) && (
                            <div>
                              <div className="text-[10px] font-semibold text-emerald-400 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> After
                              </div>
                              <div className="rounded-lg bg-emerald-950/20 border border-emerald-900/40 p-3 space-y-1.5">
                                {newObj
                                  ? Object.entries(newObj).map(([k, v]) => (
                                      <div key={k} className={`flex gap-2 text-xs rounded px-2 py-1
                                        ${oldObj && JSON.stringify(oldObj[k]) !== JSON.stringify(v) ? 'bg-emerald-900/30' : ''}`}>
                                        <span className="text-gray-500 font-mono w-32 shrink-0 truncate">{k}</span>
                                        <span className="text-emerald-300 font-mono break-all">{v === null ? <span className="text-gray-600 italic">NULL</span> : String(v)}</span>
                                      </div>
                                    ))
                                  : <pre className="text-xs text-gray-400 whitespace-pre-wrap break-all">{log.newValues}</pre>
                                }
                              </div>
                            </div>
                          )}

                          {/* NULL side label */}
                          {!oldObj && !log.oldValues && log.action === 'INSERT' && (
                            <div className="flex items-center justify-center rounded-lg border border-dashed border-gray-800 text-gray-700 text-xs py-6">No previous values (INSERT)</div>
                          )}
                          {!newObj && !log.newValues && log.action === 'DELETE' && (
                            <div className="flex items-center justify-center rounded-lg border border-dashed border-gray-800 text-gray-700 text-xs py-6">No new values (DELETE)</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Audit Pagination */}
              {auditTotal > auditPageSize && (
                <div className="shrink-0 flex items-center justify-between px-6 py-3 border-t border-gray-800 bg-gray-900/60">
                  <span className="text-xs text-gray-500 font-mono">
                    Page {auditPage} / {Math.ceil(auditTotal / auditPageSize)} · {auditTotal.toLocaleString()} logs
                  </span>
                  <div className="flex gap-1.5">
                    <button onClick={() => setAuditPage(1)} disabled={auditPage === 1}
                      className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-xs">«</button>
                    <button onClick={() => setAuditPage(p => Math.max(1, p - 1))} disabled={auditPage === 1}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-xs">‹ Prev</button>
                    {Array.from({ length: Math.min(5, Math.ceil(auditTotal / auditPageSize)) }, (_, i) => {
                      const total = Math.ceil(auditTotal / auditPageSize);
                      const start = Math.max(1, Math.min(auditPage - 2, total - 4));
                      const pg = start + i;
                      return (
                        <button key={pg} onClick={() => setAuditPage(pg)}
                          className={`w-8 h-7 rounded text-xs transition-colors
                            ${pg === auditPage ? 'bg-amber-600 text-white font-bold' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}>
                          {pg}
                        </button>
                      );
                    })}
                    <button onClick={() => setAuditPage(p => Math.min(Math.ceil(auditTotal / auditPageSize), p + 1))}
                      disabled={auditPage === Math.ceil(auditTotal / auditPageSize)}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-xs">Next ›</button>
                    <button onClick={() => setAuditPage(Math.ceil(auditTotal / auditPageSize))}
                      disabled={auditPage === Math.ceil(auditTotal / auditPageSize)}
                      className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-xs">»</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* No table selected */}
          {view === 'tables' && !activeTable && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-gray-700">
              <svg className="w-24 h-24 opacity-20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 4.69 2 8v8c0 3.31 4.48 6 10 6s10-2.69 10-6V8c0-3.31-4.48-6-10-6zm0 2c4.41 0 8 2.24 8 5s-3.59 5-8 5-8-2.24-8-5 3.59-5 8-5z"/>
              </svg>
              <p className="text-xl font-semibold text-gray-600">Choose a table</p>
              <p className="text-sm text-gray-700">{tables.length} tables available in db53357</p>
            </div>
          )}

          {/* ══ SCHEMA TAB ══ */}
          {view === 'tables' && activeTable && tab === 'schema' && (
            <div className="flex-1 flex overflow-hidden">

              {/* Column list */}
              <div className="flex-1 overflow-y-auto p-5">
                {schemaLoading && (
                  <div className="space-y-3">
                    {[...Array(6)].map((_, i) => (
                      <div key={i} className="h-14 rounded-xl bg-gray-800/60 animate-pulse" style={{ opacity: 1 - i * 0.12 }} />
                    ))}
                  </div>
                )}
                {schemaError && (
                  <div className="p-4 rounded-xl bg-red-900/30 border border-red-700 text-red-300 text-sm">⚠ {schemaError}</div>
                )}

                {schema && !schemaLoading && (
                  <div className="space-y-5">

                    {/* ── Columns ── */}
                    <section>
                      <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h18v4H3zm0 5h18v4H3zm0 5h18v4H3zm0 5h18v2H3z"/></svg>
                        Columns ({schema.columns.length})
                      </h2>
                      <div className="rounded-xl border border-gray-800 overflow-hidden">
                        <table className="min-w-full text-xs">
                          <thead>
                            <tr className="bg-gray-800/80 text-gray-400 uppercase tracking-wider text-[11px]">
                              <th className="px-4 py-2.5 text-left w-6">#</th>
                              <th className="px-4 py-2.5 text-left">Column</th>
                              <th className="px-4 py-2.5 text-left">Type</th>
                              <th className="px-4 py-2.5 text-left">Null</th>
                              <th className="px-4 py-2.5 text-left">Default</th>
                              <th className="px-4 py-2.5 text-left">Flags</th>
                              <th className="px-4 py-2.5 text-left">References</th>
                            </tr>
                          </thead>
                          <tbody>
                            {schema.columns.map((col, ri) => (
                              <tr
                                key={col.name}
                                onClick={() => setSelectedCol(selectedCol?.name === col.name ? null : col)}
                                className={`border-t border-gray-800/60 cursor-pointer transition-colors
                                  ${selectedCol?.name === col.name
                                    ? 'bg-indigo-950/60 border-l-2 border-indigo-500'
                                    : ri % 2 === 0 ? 'bg-gray-900 hover:bg-gray-800/50' : 'bg-gray-900/50 hover:bg-gray-800/50'}`}
                              >
                                <td className="px-4 py-2.5 text-gray-600 font-mono">{col.ordinal}</td>
                                <td className="px-4 py-2.5">
                                  <div className="flex items-center gap-1.5">
                                    {col.isPrimaryKey && <PkIcon />}
                                    {col.fkTable && <FkIcon />}
                                    <span className="text-gray-100 font-mono font-medium">{col.name}</span>
                                    {col.isIdentity && <IdentityIcon />}
                                  </div>
                                </td>
                                <td className="px-4 py-2.5">
                                  <span className={`inline-block px-2 py-0.5 rounded border text-[11px] font-mono font-semibold ${typeColor(col.dataType)}`}>
                                    {typeLabel(col)}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5"><NullBadge nullable={col.nullable} /></td>
                                <td className="px-4 py-2.5 text-gray-500 font-mono max-w-[120px] truncate">
                                  {col.defaultVal ?? <span className="text-gray-700">—</span>}
                                </td>
                                <td className="px-4 py-2.5">
                                  <div className="flex gap-1 flex-wrap">
                                    {col.isPrimaryKey && <span className="px-1.5 py-0 rounded bg-yellow-900/60 border border-yellow-700 text-yellow-300 text-[10px] font-bold">PK</span>}
                                    {col.isIdentity  && <span className="px-1.5 py-0 rounded bg-violet-900/60 border border-violet-700 text-violet-300 text-[10px] font-bold">Identity</span>}
                                    {col.fkTable     && <span className="px-1.5 py-0 rounded bg-sky-900/60 border border-sky-700 text-sky-300 text-[10px] font-bold">FK</span>}
                                  </div>
                                </td>
                                <td className="px-4 py-2.5 font-mono text-sky-400 text-[11px]">
                                  {col.fkTable
                                    ? <button onClick={(e) => { e.stopPropagation(); handleSelectTable(col.fkTable!); }}
                                        className="hover:underline flex items-center gap-1">
                                        <FkIcon />{col.fkTable}.{col.fkColumn}
                                      </button>
                                    : <span className="text-gray-700">—</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    {/* ── Indexes ── */}
                    {schema.indexes.length > 0 && (
                      <section>
                        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          Indexes ({schema.indexes.length})
                        </h2>
                        <div className="grid grid-cols-1 gap-2">
                          {schema.indexes.map(idx => (
                            <div key={idx.indexName} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-900 border border-gray-800">
                              <div className={`w-2 h-2 rounded-full shrink-0 ${idx.isPk ? 'bg-yellow-400' : idx.isUnique ? 'bg-indigo-400' : 'bg-gray-500'}`} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono text-sm text-white">{idx.indexName}</span>
                                  {idx.isPk     && <span className="text-[10px] px-1.5 rounded bg-yellow-900/60 border border-yellow-700 text-yellow-300 font-bold">PRIMARY KEY</span>}
                                  {idx.isUnique && !idx.isPk && <span className="text-[10px] px-1.5 rounded bg-indigo-900/60 border border-indigo-700 text-indigo-300 font-bold">UNIQUE</span>}
                                  <span className="text-[10px] px-1.5 rounded bg-gray-700 border border-gray-600 text-gray-300">{idx.indexType}</span>
                                </div>
                                <div className="text-xs text-gray-500 font-mono mt-0.5">↳ {idx.columns}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}

                    {/* ── Incoming FKs ── */}
                    {schema.incomingFks.length > 0 && (
                      <section>
                        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                          <FkIcon />
                          Referenced by ({schema.incomingFks.length})
                        </h2>
                        <div className="grid grid-cols-1 gap-2">
                          {schema.incomingFks.map((fk, i) => (
                            <div key={i} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-gray-900 border border-gray-800">
                              <button onClick={() => handleSelectTable(fk.fromTable)}
                                className="font-mono text-sm text-sky-400 hover:underline shrink-0">
                                {fk.fromTable}
                              </button>
                              <span className="text-gray-600 text-xs">·</span>
                              <span className="font-mono text-xs text-sky-300">{fk.fromColumn}</span>
                              <svg className="w-4 h-4 text-gray-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                              </svg>
                              <span className="font-mono text-xs text-gray-300">{schema.tableName}.{fk.toColumn}</span>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </div>

              {/* ── Column detail panel ── */}
              {selectedCol && (
                <aside className="w-72 shrink-0 border-l border-gray-800 bg-gray-900/80 overflow-y-auto p-5 flex flex-col gap-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {selectedCol.isPrimaryKey && <PkIcon />}
                        {selectedCol.fkTable && <FkIcon />}
                        <h3 className="font-mono font-bold text-white text-sm truncate">{selectedCol.name}</h3>
                      </div>
                      <span className={`mt-1 inline-block px-2 py-0.5 rounded border text-[11px] font-mono font-semibold ${typeColor(selectedCol.dataType)}`}>
                        {typeLabel(selectedCol)}
                      </span>
                    </div>
                    <button onClick={() => setSelectedCol(null)} className="text-gray-600 hover:text-gray-300 shrink-0">✕</button>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {[
                      { label: 'Ordinal', value: selectedCol.ordinal },
                      { label: 'Data Type', value: selectedCol.dataType },
                      { label: 'Max Length', value: selectedCol.maxLength === -1 ? 'MAX' : selectedCol.maxLength ?? '—' },
                      { label: 'Precision', value: selectedCol.precision ?? '—' },
                      { label: 'Scale', value: selectedCol.scale ?? '—' },
                      { label: 'Nullable', value: selectedCol.nullable ? 'YES' : 'NO' },
                    ].map(r => (
                      <div key={r.label} className="bg-gray-800/60 rounded-lg p-2.5">
                        <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">{r.label}</div>
                        <div className="font-mono text-gray-200">{String(r.value)}</div>
                      </div>
                    ))}
                  </div>

                  {selectedCol.defaultVal && (
                    <div className="bg-gray-800/60 rounded-lg p-3">
                      <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">Default Value</div>
                      <div className="font-mono text-gray-200 text-xs break-all">{selectedCol.defaultVal}</div>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {selectedCol.isPrimaryKey && (
                      <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-yellow-900/30 border border-yellow-800">
                        <PkIcon /><span className="text-yellow-300 text-xs font-semibold">Primary Key</span>
                      </div>
                    )}
                    {selectedCol.isIdentity && (
                      <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-900/30 border border-violet-800">
                        <span className="text-violet-300 text-xs font-semibold">🔢 Auto-Increment Identity</span>
                      </div>
                    )}
                  </div>

                  {selectedCol.fkTable && (
                    <div className="bg-sky-900/20 border border-sky-800 rounded-xl p-3">
                      <div className="text-sky-400 text-[10px] uppercase tracking-wider mb-2 font-semibold flex items-center gap-1"><FkIcon /> Foreign Key</div>
                      <button onClick={() => handleSelectTable(selectedCol.fkTable!)}
                        className="font-mono text-sm text-sky-300 hover:underline block">
                        {selectedCol.fkTable}
                      </button>
                      <div className="font-mono text-xs text-sky-400/70 mt-0.5">↳ {selectedCol.fkColumn}</div>
                    </div>
                  )}
                </aside>
              )}
            </div>
          )}

          {/* ══ DATA TAB ══ */}
          {view === 'tables' && activeTable && tab === 'data' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-auto p-5">
                {dataLoading && (
                  <div className="space-y-2">
                    <div className="h-10 rounded-lg bg-gray-800 animate-pulse" />
                    {[...Array(8)].map((_, i) => (
                      <div key={i} className="h-8 rounded bg-gray-800/60 animate-pulse" style={{ opacity: 1 - i * 0.1 }} />
                    ))}
                  </div>
                )}
                {dataError && (
                  <div className="p-4 rounded-xl bg-red-900/30 border border-red-700 text-red-300 text-sm">⚠ {dataError}</div>
                )}
                {!dataLoading && tableData && tableData.rows.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-20 text-gray-600 gap-2">
                    <p className="text-lg font-medium">This table is empty</p>
                  </div>
                )}
                {!dataLoading && tableData && tableData.rows.length > 0 && (
                  <div className="rounded-xl border border-gray-800 overflow-hidden shadow-xl">
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-xs">
                        <thead>
                          <tr className="bg-gray-800/90">
                            {tableData.columns.map(col => {
                              const schemaCol = schema?.columns.find(c => c.name === col);
                              return (
                                <th key={col} className="px-4 py-3 text-left whitespace-nowrap border-b border-gray-700">
                                  <div className="flex items-center gap-1.5">
                                    {schemaCol?.isPrimaryKey && <PkIcon />}
                                    {schemaCol?.fkTable && <FkIcon />}
                                    <span className="text-gray-300 font-mono font-semibold text-[11px] uppercase tracking-wide">{col}</span>
                                    {schemaCol && (
                                      <span className={`px-1.5 py-0 rounded border text-[10px] font-mono ${typeColor(schemaCol.dataType)}`}>
                                        {schemaCol.dataType}
                                      </span>
                                    )}
                                  </div>
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {tableData.rows.map((row, ri) => (
                            <tr key={ri} className={`border-b border-gray-800/50 hover:bg-indigo-950/20 transition-colors
                              ${ri % 2 === 0 ? 'bg-gray-900' : 'bg-gray-900/40'}`}>
                              {tableData.columns.map(col => (
                                <td key={col} className="px-4 py-2 text-gray-300 font-mono whitespace-nowrap max-w-[200px] truncate">
                                  {row[col] === null
                                    ? <span className="text-gray-700 italic text-[11px]">NULL</span>
                                    : <span title={fmt(row[col])}>{fmt(row[col])}</span>}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {/* Pagination */}
              {tableData && tableData.totalRows > pageSize && (
                <div className="shrink-0 flex items-center justify-between px-6 py-3 border-t border-gray-800 bg-gray-900/60">
                  <span className="text-xs text-gray-500 font-mono">
                    Page {page} / {totalPages} · {tableData.totalRows.toLocaleString()} rows
                  </span>
                  <div className="flex gap-1.5">
                    <button onClick={() => setPage(1)} disabled={page === 1}
                      className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-xs transition-colors">«</button>
                    <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-xs transition-colors">‹ Prev</button>
                    {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                      const start = Math.max(1, Math.min(page - 3, totalPages - 6));
                      const pg = start + i;
                      return (
                        <button key={pg} onClick={() => setPage(pg)}
                          className={`w-8 h-7 rounded text-xs transition-colors
                            ${pg === page ? 'bg-indigo-600 text-white font-bold' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}`}>
                          {pg}
                        </button>
                      );
                    })}
                    <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-xs transition-colors">Next ›</button>
                    <button onClick={() => setPage(totalPages)} disabled={page === totalPages}
                      className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-xs transition-colors">»</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

