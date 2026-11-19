import { useState, type ReactNode } from 'react';
import type { BroadcastResult } from '../rpc';
import { useDashboard } from '../App';
import { Btn, Field, KV, Panel, inputClass, reasonText } from '../ui';

export default function BroadcastSection(): ReactNode {
  const { client, notify, devices } = useDashboard();
  const [url, setUrl] = useState('');
  const [dark, setDark] = useState(false);
  const [summary, setSummary] = useState<{ label: string; result: BroadcastResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const booted = devices.filter((device) => device.state === 'booted');

  const send = async (method: string, params: Record<string, unknown>, label: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.call<BroadcastResult>(method, params);
      setSummary({ label, result });
      notify(`${label}: reached ${result.sent} target${result.sent === 1 ? '' : 's'}`, result.sent > 0 ? 'good' : 'warn');
    } catch (reason: unknown) {
      const message = reasonText(reason);
      setError(message);
      setSummary(null);
      notify(`${method}: ${message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const toggleDark = (): void => {
    const enabled = !dark;
    setDark(enabled);
    void send('broadcast.darkMode', { enabled }, `Dark mode ${enabled ? 'on' : 'off'}`);
  };

  return (
    <Panel title="Broadcast" subtitle={`${booted.length} booted device${booted.length === 1 ? '' : 's'}`}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div>
          <div className="rounded bg-surface px-4 py-3">
            <KV label="targets" value={`${booted.length} booted`} tone={booted.length ? 'good' : 'muted'} />
            <KV label="platforms" value={[...new Set(booted.map((device) => device.platform))].join(', ') || '—'} />
          </div>

          <h3 className="mb-2 mt-6 font-display text-base font-semibold">Actions</h3>
          <div className="flex flex-wrap gap-2">
            <Btn solid tone="accent" disabled={busy} onClick={() => void send('broadcast.reload', {}, 'Reload')}>Reload all</Btn>
            <Btn disabled={busy} onClick={toggleDark}>Dark mode: {dark ? 'on' : 'off'}</Btn>
          </div>

          <div className="mt-5">
            <Field label="Deep link" hint="A valid URL, for example myapp://path">
              <div className="flex gap-2">
                <input className={inputClass} type="url" value={url} placeholder="myapp://open?screen=home"
                  onChange={(event) => setUrl(event.target.value)} />
                <Btn disabled={busy || url.trim().length === 0} onClick={() => void send('broadcast.deepLink', { url }, `Deep link ${url}`)}>Send</Btn>
              </div>
            </Field>
          </div>

          {error && <p className="mt-4 rounded bg-bad/10 px-3 py-2 font-mono text-xs text-bad">{error}</p>}
          <p className="mt-4 text-[11px] text-muted">Actions run on every booted device reported by the daemon. Results are reported per target below.</p>
        </div>

        <div>
          <h3 className="mb-2 font-display text-base font-semibold">Result summary</h3>
          {!summary ? (
            <p className="text-sm text-muted">No broadcast sent yet.</p>
          ) : (
            <div className="rounded bg-surface p-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <span className="text-sm text-inktext">{summary.label}</span>
                <span className={`font-mono text-xs ${summary.result.sent ? 'text-good' : 'text-warn'}`}>
                  {summary.result.sent} reached
                </span>
              </div>
              {summary.result.results.length === 0 ? (
                <p className="text-xs text-muted">No targets were available.</p>
              ) : (
                <ul className="space-y-1 font-mono text-xs">
                  {summary.result.results.map((item, index) => (
                    <li key={`${item.id}-${index}`} className="flex items-start gap-2 border-b border-line/60 py-1.5 last:border-0">
                      <span className={item.ok ? 'text-good' : 'text-bad'}>{item.ok ? '✓' : '✗'}</span>
                      <span className="w-20 shrink-0 truncate text-muted">{item.platform}</span>
                      <span className="min-w-0 break-all text-inktext">{item.id}</span>
                      <span className="ml-auto shrink-0 text-muted">{item.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
