import { useEffect, useState, type ReactNode } from 'react';
import { useDashboard } from '../App';
import { Btn, Empty, KV, Panel, reasonText } from '../ui';

interface Result { ok: boolean; message: string }

export default function MetroSection(): ReactNode {
  const { client, notify, metro, setMetro, project, refreshProject } = useDashboard();
  const [resetCache, setResetCache] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { refreshProject(); }, [refreshProject]);

  const invoke = async (method: string, params: Record<string, unknown>, label: string, onSuccess?: (outcome: Record<string, unknown>) => void): Promise<void> => {
    setBusy(true);
    try {
      const outcome = await client.call<Record<string, unknown>>(method, params);
      const flag = outcome.started ?? outcome.sent ?? outcome.stopped;
      const ok = flag === undefined ? true : Boolean(flag);
      const message = typeof outcome.message === 'string' && outcome.message
        ? outcome.message
        : ok ? `${label} succeeded` : `${label} was refused`;
      setResult({ ok, message });
      notify(message, ok ? 'good' : 'warn');
      if (ok) onSuccess?.(outcome);
    } catch (reason: unknown) {
      const message = reasonText(reason);
      setResult({ ok: false, message });
      notify(`${method}: ${message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const statusTone = metro.status === 'running' ? 'text-good' : metro.status === 'stopped' ? 'text-bad' : 'text-warn';
  const scripts = project?.scripts ?? [];

  return (
    <Panel title="Metro" subtitle={metro.status} right={<span className={`font-mono text-xs ${statusTone}`}>● {metro.status}</span>}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <div className="rounded bg-surface px-4 py-3">
            <KV label="status" value={metro.status} tone={metro.status === 'running' ? 'good' : 'muted'} />
            {metro.pid !== undefined && <KV label="pid" value={String(metro.pid)} />}
            <KV label="project" value={project?.name ?? '…'} />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Btn solid tone="good" disabled={busy} onClick={() => void invoke('metro.start', { resetCache }, 'Metro start', (outcome) => {
              setMetro({ status: 'running', pid: typeof outcome.pid === 'number' ? outcome.pid : undefined });
            })}>Start</Btn>
            <Btn solid tone="bad" disabled={busy} onClick={() => void invoke('metro.stop', {}, 'Metro stop', () => setMetro({ status: 'stopped' }))}>Stop</Btn>
            <Btn disabled={busy} onClick={() => void invoke('metro.reload', {}, 'Reload')}>Reload</Btn>
            <Btn disabled={busy} onClick={() => void invoke('metro.devMenu', {}, 'Dev menu')}>Dev menu</Btn>
          </div>
          <label className="mt-4 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={resetCache} onChange={(event) => setResetCache(event.target.checked)}
              className="accent-[#22d3ee]" />
            Reset cache on start
          </label>

          {result && (
            <p className={`mt-4 rounded px-3 py-2 font-mono text-xs ${result.ok ? 'bg-good/10 text-good' : 'bg-bad/10 text-bad'}`}>
              {result.message}
            </p>
          )}
          <p className="mt-3 text-[11px] text-muted">Metro status comes from daemon events and your start/stop actions.</p>
        </div>

        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="font-display text-base font-semibold">Package scripts</h3>
            <span className="font-mono text-xs text-muted">{project?.name ?? 'no project'}</span>
          </div>
          {!project || scripts.length === 0 ? (
            <Empty>No scripts found in this project&apos;s package.json.</Empty>
          ) : (
            <div className="space-y-1">
              {scripts.map((script) => (
                <div key={script.name} className="flex items-center gap-3 rounded px-3 py-2 hover:bg-surface">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm text-inktext">{script.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted">{script.command}</p>
                  </div>
                  <Btn disabled={busy} onClick={() => void invoke('project.runScript', { name: script.name }, `Run ${script.name}`)}>Run</Btn>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
