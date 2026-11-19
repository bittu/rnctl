import { useEffect, useState, type ReactNode } from 'react';
import type { StorageApp, StorageEntry, StorageSource } from '../rpc';
import { useDashboard } from '../App';
import { Btn, Empty, Field, Panel, Pill, inputClass, cut, reasonText } from '../ui';

export default function StorageSection(): ReactNode {
  const { client, notify } = useDashboard();
  const [apps, setApps] = useState<StorageApp[] | null>(null);
  const [app, setApp] = useState<StorageApp | null>(null);
  const [sources, setSources] = useState<StorageSource[] | null>(null);
  const [source, setSource] = useState<StorageSource | null>(null);
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client.call<{ apps: StorageApp[] }>('storage.apps')
      .then((result) => setApps(result.apps))
      .catch((reason: unknown) => { notify(`storage.apps: ${reasonText(reason)}`, 'bad'); setApps([]); });
  }, [client, notify]);

  const openApp = (next: StorageApp): void => {
    setApp(next);
    setSources(null);
    setSource(null);
    setEntries([]);
    setSelectedKey(null);
    setMessage(null);
    void client.call<{ sources: StorageSource[] }>('storage.sources', { app: next.id, platform: next.platform })
      .then((result) => setSources(result.sources))
      .catch((reason: unknown) => { notify(`storage.sources: ${reasonText(reason)}`, 'bad'); setSources([]); });
  };

  const openSource = (next: StorageSource): void => {
    if (!next.available) {
      notify(next.reason ?? 'This storage source is unavailable', 'warn');
      return;
    }
    if (!app) return;
    setSource(next);
    setEntries([]);
    setSelectedKey(null);
    setMessage(null);
    void client.call<{ available: boolean; reason?: string; entries: StorageEntry[] }>('storage.read', {
      app: app.id, platform: app.platform, source: next.id, kind: next.kind, limit: 200,
    })
      .then((result) => {
        if (!result.available) {
          setMessage(result.reason ?? 'Storage read is unavailable');
          return;
        }
        setEntries(result.entries);
        setSelectedKey(result.entries[0]?.key ?? null);
        setDraft(result.entries[0]?.value ?? '');
      })
      .catch((reason: unknown) => { setMessage(reasonText(reason)); notify(`storage.read: ${reasonText(reason)}`, 'bad'); });
  };

  const startEdit = (entry: StorageEntry): void => {
    setSelectedKey(entry.key);
    setDraft(entry.value);
    setConfirming(false);
    setConfirmText('');
  };

  const write = (): void => {
    if (!app || !source || !selectedKey) return;
    setBusy(true);
    void client.call<{ written: boolean; key?: string; reason?: string }>('storage.write', {
      app: app.id, platform: app.platform, source: source.id, kind: source.kind,
      key: selectedKey, value: draft, confirm: true,
    })
      .then((result) => {
        setConfirming(false);
        setConfirmText('');
        const text = result.written ? `Wrote ${result.key ?? selectedKey}` : result.reason ?? 'Write refused';
        setMessage(text);
        notify(text, result.written ? 'good' : 'bad');
        if (!result.written) return;
        void client.call<{ available: boolean; entries: StorageEntry[] }>('storage.read', {
          app: app.id, platform: app.platform, source: source.id, kind: source.kind, limit: 200, terminate: false,
        }).then((r) => { if (r.available) setEntries(r.entries); }).catch(() => { /* write result already reported */ });
      })
      .catch((reason: unknown) => { setMessage(reasonText(reason)); notify(`storage.write: ${reasonText(reason)}`, 'bad'); })
      .finally(() => setBusy(false));
  };

  const step = !app ? 0 : !source ? 1 : 2;

  return (
    <Panel title="Storage" subtitle={`step ${step + 1} of 3 · ${app?.id ?? 'select an app'}`}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div>
          <h3 className="mb-2 font-display text-base font-semibold">1 · Apps</h3>
          {!apps ? <p className="text-sm text-muted">Looking for installed apps…</p> : apps.length === 0 ? (
            <Empty>No apps found. Boot a simulator or connect an Android device.</Empty>
          ) : (
            <div className="mb-6 max-h-52 space-y-1 overflow-auto">
              {apps.map((item) => (
                <button key={`${item.platform}-${item.id}`} type="button" onClick={() => openApp(item)}
                  className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left ${app?.id === item.id ? 'bg-raised' : 'hover:bg-surface'}`}>
                  <Pill tone={item.platform === 'ios' ? 'accent' : 'good'}>{item.platform}</Pill>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-inktext">{item.id}</span>
                </button>
              ))}
            </div>
          )}

          {app && (
            <>
              <h3 className="mb-2 font-display text-base font-semibold">2 · Sources</h3>
              {!sources ? <p className="text-sm text-muted">Scanning app container…</p> : sources.length === 0 ? (
                <Empty>No storage files found in this app&apos;s container.</Empty>
              ) : (
                <div className="max-h-64 space-y-1 overflow-auto">
                  {sources.map((item) => (
                    <button key={item.id} type="button" onClick={() => openSource(item)}
                      className={`w-full rounded px-3 py-2 text-left ${source?.id === item.id ? 'bg-raised' : 'hover:bg-surface'}`}>
                      <div className="flex items-center gap-2">
                        <Pill tone={item.available ? 'good' : 'muted'}>{item.kind}</Pill>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-inktext">{cut(item.path, 42)}</span>
                      </div>
                      {!item.available && <p className="mt-1 text-[11px] text-warn">{item.reason ?? 'Unavailable'}</p>}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div>
          <h3 className="mb-2 font-display text-base font-semibold">3 · Entries</h3>
          {!source ? (
            <Empty>Select an app and a storage source to read its entries.</Empty>
          ) : source.kind === 'mmkv' ? (
            <div className="rounded border border-warn/40 bg-warn/10 p-4 text-sm text-warn">
              MMKV is not supported in the web dashboard. Reading it needs a parser and, for encrypted stores, an app-provided key.
            </div>
          ) : entries.length === 0 ? (
            <Empty>{message ?? 'No entries in this store.'}</Empty>
          ) : (
            <>
              <div className="max-h-72 overflow-auto rounded border border-line">
                <table className="w-full border-collapse text-left font-mono text-xs">
                  <thead className="sticky top-0 bg-surface text-muted">
                    <tr className="border-b border-line"><th className="px-3 py-2 font-normal">key</th><th className="px-3 py-2 font-normal">value</th></tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.key} onClick={() => startEdit(entry)}
                        className={`cursor-pointer border-b border-line/50 ${selectedKey === entry.key ? 'bg-raised' : 'hover:bg-surface'}`}>
                        <td className="max-w-[12rem] truncate px-3 py-1.5 text-accent">{entry.key}</td>
                        <td className="max-w-[24rem] truncate px-3 py-1.5 text-inktext">{entry.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {selectedKey && (
                <div className="mt-4 rounded bg-surface p-4">
                  <Field label={`Edit value · ${selectedKey}`}>
                    <textarea className={`${inputClass} min-h-20 resize-y`} value={draft} onChange={(event) => setDraft(event.target.value)} />
                  </Field>
                  {!confirming ? (
                    <div className="mt-3 flex items-center gap-2">
                      <Btn disabled={busy} onClick={() => setConfirming(true)}>Edit value…</Btn>
                      <span className="text-[11px] text-muted">Writes require a confirmation step.</span>
                    </div>
                  ) : (
                    <div className="mt-3 space-y-2 rounded border border-warn/40 p-3">
                      <p className="text-xs text-warn">This writes directly to the app&apos;s store. Type <code className="font-mono font-semibold">write</code> to confirm.</p>
                      <div className="flex gap-2">
                        <input className={`${inputClass} max-w-xs`} value={confirmText} placeholder="write"
                          onChange={(event) => setConfirmText(event.target.value)} />
                        <Btn solid tone="warn" disabled={busy || confirmText.trim().toLowerCase() !== 'write'} onClick={write}>Confirm write</Btn>
                        <Btn disabled={busy} onClick={() => { setConfirming(false); setConfirmText(''); }}>Cancel</Btn>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {message && <p className="mt-3 break-all font-mono text-xs text-warn">{message}</p>}
          <p className="mt-4 text-[11px] text-muted">
            Reads copy the store to a temporary file and terminate the app first. Writes make a backup before changing a value.
          </p>
        </div>
      </div>
    </Panel>
  );
}
