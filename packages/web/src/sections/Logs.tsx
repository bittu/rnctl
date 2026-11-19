import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LogEntry, LogLevel, LogSource, NetworkEntry, NetworkStatus } from '../rpc';
import { useDashboard } from '../App';
import { Btn, Empty, Panel, TONE_CLASS, clock, cut, reasonText, redactEntry, redactHeaders } from '../ui';

interface Tab { key: string; label: string; sourceId?: string; sessionId?: string }

const LEVEL_CLASS: Record<LogLevel, string> = {
  debug: 'text-muted', info: 'text-accent', warn: 'text-warn', error: 'text-bad',
};

function matchesSession(entry: LogEntry, tab: Tab): boolean {
  if (tab.sourceId === 'metro' || tab.sourceId === 'console') return entry.source === 'metro';
  if (tab.sourceId === 'android') return entry.source === `logcat:${tab.sessionId}`;
  if (tab.sourceId === 'ios') return entry.source === `simlog:${tab.sessionId}`;
  return false;
}

function mergeById(...groups: LogEntry[][]): LogEntry[] {
  const seen = new Set<string>();
  return groups.flat().filter((entry) => !seen.has(entry.id) && Boolean(seen.add(entry.id)));
}

export default function LogsSection(): ReactNode {
  const { client, notify, entries, clearEntries, networkEntries } = useDashboard();
  const [sources, setSources] = useState<LogSource[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([{ key: 'all', label: 'All' }]);
  const [activeTab, setActiveTab] = useState('all');
  const [history, setHistory] = useState<Record<string, LogEntry[]>>({});
  const [networkRows, setNetworkRows] = useState<NetworkEntry[]>([]);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);

  useEffect(() => {
    void client.call<{ sources: LogSource[] }>('logs.sources')
      .then((result) => setSources(result.sources))
      .catch((reason: unknown) => notify(`logs.sources: ${reasonText(reason)}`, 'bad'));
    void client.call<NetworkStatus>('network.status')
      .then(setNetworkStatus)
      .catch((reason: unknown) => notify(`network.status: ${reasonText(reason)}`, 'bad'));
    void client.call<{ entries: NetworkEntry[] }>('network.list', { limit: 200 })
      .then((result) => setNetworkRows(result.entries.map(redactEntry)))
      .catch((reason: unknown) => notify(`network.list: ${reasonText(reason)}`, 'bad'));
  }, [client, notify]);

  const closeTab = (tab: Tab): void => {
    if (!tab.sessionId) return;
    void client.call<{ detached: boolean }>('logs.detach', { sessionId: tab.sessionId })
      .then((result) => notify(result.detached ? `Detached ${tab.label}` : 'Session was already detached', result.detached ? 'good' : 'warn'))
      .catch((reason: unknown) => notify(`logs.detach: ${reasonText(reason)}`, 'bad'));
    setTabs((current) => current.filter((item) => item.key !== tab.key));
    setActiveTab((current) => current === tab.key ? 'all' : current);
  };

  const openSource = (source: LogSource): void => {
    if (source.id === 'network') {
      setActiveTab('network');
      return;
    }
    if (!source.available) {
      notify(source.reason ?? `${source.label} is not available`, 'warn');
      setActiveTab('network');
      return;
    }
    void client.call<{ sessionId: string; started: boolean; message: string }>('logs.attach', { source: source.id })
      .then((result) => {
        notify(result.message, result.started ? 'good' : 'warn');
        if (!result.started || !result.sessionId) return;
        const tab: Tab = { key: result.sessionId, label: source.label, sourceId: source.id, sessionId: result.sessionId };
        setTabs((current) => [...current, tab]);
        setActiveTab(tab.key);
        void client.call<{ entries: LogEntry[] }>('logs.list', { sessionId: result.sessionId, limit: 200 })
          .then((list) => setHistory((current) => ({ ...current, [result.sessionId]: list.entries })))
          .catch(() => { /* live events still populate the tab */ });
      })
      .catch((reason: unknown) => notify(`logs.attach: ${reasonText(reason)}`, 'bad'));
  };

  const active = tabs.find((tab) => tab.key === activeTab);
  const visible = useMemo(() => {
    if (activeTab === 'network') return [];
    if (!active || active.key === 'all') return entries.slice(-200);
    return mergeById(history[active.sessionId ?? ''] ?? [], entries.filter((entry) => matchesSession(entry, active))).slice(-200);
  }, [activeTab, active, entries, history]);

  const networkList = useMemo(() => {
    const seen = new Set<string>();
    return [...networkRows, ...networkEntries].filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)));
  }, [networkRows, networkEntries]);
  const detail = networkList.find((row) => row.id === selectedRequest);

  const toggleNetwork = (): void => {
    const method = networkStatus?.attached ? 'network.detach' : 'network.attach';
    const params = networkStatus?.attached ? {} : { port: 8081 };
    void client.call<{ attached?: boolean; detached?: boolean; message?: string }>(method, params)
      .then((outcome) => {
        setNetworkStatus((current) => current ? {
          ...current,
          attached: 'attached' in outcome ? Boolean(outcome.attached) : !outcome.detached,
        } : current);
        if (outcome.message) notify(outcome.message, 'good');
      })
      .catch((reason: unknown) => notify(`${method}: ${reasonText(reason)}`, 'bad'));
  };

  const chip = (tab: Tab): ReactNode => (
    <div key={tab.key} className={`flex items-center rounded ${activeTab === tab.key ? 'bg-raised text-inktext' : 'text-muted'}`}>
      <button type="button" onClick={() => setActiveTab(tab.key)} className="px-3 py-1.5 font-mono text-xs">
        {activeTab === tab.key && <span className="mr-1 text-accent">▸</span>}{tab.label}
      </button>
      {tab.sessionId && (
        <button type="button" aria-label={`Detach ${tab.label}`} title="Detach"
          onClick={() => closeTab(tab)} className="px-2 py-1.5 font-mono text-xs text-muted hover:text-bad">×</button>
      )}
    </div>
  );

  return (
    <Panel
      title="Live logs"
      subtitle={`${activeTab === 'network' ? networkList.length : visible.length} entries · ${tabs.length - 1} sessions`}
      right={
        <Btn onClick={() => {
          clearEntries();
          setHistory({});
          void client.call('logs.clear').catch((reason: unknown) => notify(`logs.clear: ${reasonText(reason)}`, 'bad'));
        }}>Clear</Btn>
      }
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-line pb-3">
        {tabs.map(chip)}
        <button type="button" onClick={() => setActiveTab('network')}
          className={`rounded px-3 py-1.5 font-mono text-xs ${activeTab === 'network' ? 'bg-raised text-inktext' : 'text-muted hover:text-inktext'}`}>
          {activeTab === 'network' && <span className="mr-1 text-accent">▸</span>}Network
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line py-3">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted">Attach source</span>
        {sources.map((source) => (
          <Btn key={source.id} onClick={() => openSource(source)}
            title={source.reason}
            className={!source.available ? 'opacity-50' : ''}>
            {source.available ? '' : '⊘ '}{source.label}
          </Btn>
        ))}
      </div>

      {activeTab === 'network' ? (
        <>
          {networkStatus && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded bg-surface px-3 py-2">
              <p className={`text-xs ${networkStatus.available ? 'text-muted' : 'text-warn'}`}>
                {networkStatus.available
                  ? `Inspector ${networkStatus.attached ? 'attached' : 'ready'} · ${networkStatus.targets} target(s)`
                  : networkStatus.reason ?? 'Network inspection is unavailable.'}
              </p>
              <Btn disabled={!networkStatus.available} onClick={toggleNetwork}>
                {networkStatus.attached ? 'Detach' : 'Attach'}
              </Btn>
            </div>
          )}
          <div className="mt-3 min-h-0 flex-1 overflow-auto">
            {networkList.length === 0 ? (
              <Empty>No requests captured yet. Attach the network inspector to see requests here.</Empty>
            ) : (
              <table className="w-full border-collapse text-left font-mono text-xs">
                <thead className="sticky top-0 bg-ink text-muted">
                  <tr className="border-b border-line">
                    <th className="py-2 pr-3 font-normal">time</th>
                    <th className="py-2 pr-3 font-normal">method</th>
                    <th className="py-2 pr-3 font-normal">status</th>
                    <th className="py-2 pr-3 font-normal">url</th>
                    <th className="py-2 pr-3 text-right font-normal">duration</th>
                  </tr>
                </thead>
                <tbody>
                  {networkList.map((row) => {
                    const failed = Boolean(row.errorText) || (row.status !== undefined && row.status >= 400);
                    let target = row.url;
                    try { target = `${new URL(row.url).host}${new URL(row.url).pathname}`; } catch { /* keep raw url */ }
                    return (
                      <tr key={row.id} onClick={() => setSelectedRequest(row.id)}
                        className={`cursor-pointer border-b border-line/60 hover:bg-surface ${detail?.id === row.id ? 'bg-surface' : ''}`}>
                        <td className="py-1.5 pr-3 text-muted">{clock(row.timestamp)}</td>
                        <td className="py-1.5 pr-3 text-accent">{cut(row.method, 5)}</td>
                        <td className={`py-1.5 pr-3 ${failed ? 'text-bad' : 'text-good'}`}>{row.errorText ? 'ERR' : row.status ?? '···'}</td>
                        <td className="max-w-[36rem] truncate py-1.5 pr-3 text-inktext">{target}</td>
                        <td className="py-1.5 pr-3 text-right text-muted">{row.durationMs === undefined ? '' : `${Math.round(row.durationMs)}ms`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {detail && (
            <div className="mt-4 shrink-0 rounded bg-surface p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs text-inktext">{detail.method} {detail.url}</p>
                  <p className={`mt-1 font-mono text-xs ${detail.status && detail.status >= 400 ? 'text-bad' : 'text-good'}`}>
                    {detail.status ?? 'pending'} {detail.statusText ?? ''} {detail.errorText ?? ''}
                  </p>
                </div>
                <Btn onClick={() => setSelectedRequest(null)}>Close</Btn>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {([['Request headers', detail.requestHeaders], ['Response headers', detail.responseHeaders]] as const).map(([label, headers]) => (
                  <div key={label}>
                    <h4 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted">{label}</h4>
                    {redactHeaders(headers).length === 0 ? <p className="text-xs text-muted">none</p> : (
                      <dl className="space-y-0.5 font-mono text-[11px]">
                        {redactHeaders(headers).map(([key, value]) => (
                          <div key={key} className="flex gap-2">
                            <dt className="w-40 shrink-0 truncate text-muted">{key}</dt>
                            <dd className="min-w-0 break-all text-inktext">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : visible.length === 0 ? (
        <Empty>No entries in this stream yet. Attach a source or start Metro.</Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {visible.map((entry) => (
            <div key={entry.id} className="flex gap-3 border-b border-line/50 py-1 font-mono text-xs hover:bg-surface">
              <span className="shrink-0 text-muted">{clock(entry.timestamp)}</span>
              <span className={`w-12 shrink-0 uppercase ${LEVEL_CLASS[entry.level]}`}>{cut(entry.level, 5)}</span>
              <span className="w-24 shrink-0 truncate text-muted">{cut(entry.source, 16)}</span>
              <span className="min-w-0 break-all text-inktext">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
      <p className={`mt-3 text-[11px] ${TONE_CLASS.muted}`}>
        Credential headers (Authorization, Cookie, Set-Cookie, x-api-key, x-auth-token) are redacted before display.
      </p>
    </Panel>
  );
}
