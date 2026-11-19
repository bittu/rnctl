import { useEffect, useState, type ReactNode } from 'react';
import type { DoctorCheck, NukePreview, NukeResult, NukeTarget } from '../rpc';
import { useDashboard } from '../App';
import { Btn, Empty, Panel, Pill, formatBytes, inputClass, reasonText } from '../ui';

export default function EnvironmentSection(): ReactNode {
  const { client, notify } = useDashboard();
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [healthy, setHealthy] = useState(false);
  const [targets, setTargets] = useState<NukeTarget[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<NukePreview | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [result, setResult] = useState<NukeResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client.call<{ healthy: boolean; checks: DoctorCheck[] }>('doctor.check')
      .then((outcome) => { setChecks(outcome.checks); setHealthy(outcome.healthy); })
      .catch((reason: unknown) => notify(`doctor.check: ${reasonText(reason)}`, 'bad'));
    void client.call<{ targets: NukeTarget[] }>('nuke.targets')
      .then((outcome) => setTargets(outcome.targets))
      .catch((reason: unknown) => notify(`nuke.targets: ${reasonText(reason)}`, 'bad'));
  }, [client, notify]);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setPreview(null);
    setResult(null);
  };

  const doPreview = (): void => {
    setBusy(true);
    void client.call<NukePreview>('nuke.preview', { targets: [...selected] })
      .then((outcome) => { setPreview(outcome); setResult(null); setConfirmText(''); })
      .catch((reason: unknown) => notify(`nuke.preview: ${reasonText(reason)}`, 'bad'))
      .finally(() => setBusy(false));
  };

  const doRun = (): void => {
    setBusy(true);
    void client.call<NukeResult>('nuke.run', { targets: [...selected], confirm: true })
      .then((outcome) => {
        setResult(outcome);
        setPreview(null);
        setConfirmText('');
        notify(`Reclaimed ${formatBytes(outcome.reclaimedBytes)}`, outcome.errors.length === 0 ? 'good' : 'warn');
        void client.call<{ targets: NukeTarget[] }>('nuke.targets').then((r) => setTargets(r.targets)).catch(() => { /* list is informational */ });
        setSelected(new Set());
      })
      .catch((reason: unknown) => notify(`nuke.run: ${reasonText(reason)}`, 'bad'))
      .finally(() => setBusy(false));
  };

  return (
    <Panel title="Environment" subtitle={checks ? (healthy ? 'healthy' : 'issues found') : 'checking…'}
      right={checks && <Pill tone={healthy ? 'good' : 'bad'}>{healthy ? 'all checks passed' : 'attention needed'}</Pill>}>
      <div className="grid gap-8 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 font-display text-base font-semibold">Doctor checks</h3>
          {!checks ? <p className="text-sm text-muted">Running environment probes…</p> : (
            <div className="space-y-1">
              {checks.map((check) => (
                <div key={check.name} className="flex items-start gap-3 rounded px-3 py-2.5 hover:bg-surface">
                  <span className={`mt-0.5 font-mono text-xs ${check.ok ? 'text-good' : 'text-bad'}`}>{check.ok ? '●' : '○'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm text-inktext">{check.name}</p>
                    <p className="break-all text-xs text-muted">{check.detail || 'no detail'}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-1 font-display text-base font-semibold">Cache cleanup</h3>
          <p className="mb-3 text-xs text-muted">Preview exactly what would be removed. Nothing is deleted until you confirm.</p>
          {!targets ? <p className="text-sm text-muted">Scanning cache targets…</p> : targets.length === 0 ? (
            <Empty>No cache targets detected in this project.</Empty>
          ) : (
            <div className="space-y-1">
              {targets.map((target) => (
                <label key={target.id} className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 hover:bg-surface">
                  <input type="checkbox" checked={selected.has(target.id)} onChange={() => toggle(target.id)}
                    className="accent-[#22d3ee]" />
                  <span className="min-w-0 flex-1 text-sm text-inktext">{target.label}</span>
                  <span className="font-mono text-xs text-muted">{formatBytes(target.sizeBytes)}</span>
                </label>
              ))}
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <Btn disabled={busy || selected.size === 0} onClick={doPreview}>Preview</Btn>
            <Btn disabled={busy || selected.size === 0} tone="bad" onClick={() => { setPreview(null); setSelected(new Set()); }}>Clear selection</Btn>
          </div>

          {preview && (
            <div className="mt-4 rounded border border-warn/40 bg-warn/5 p-4">
              <h4 className="font-mono text-xs uppercase tracking-wider text-warn">Planned removals · {formatBytes(preview.totalBytes)}</h4>
              <ul className="mt-2 space-y-1 font-mono text-[11px] text-inktext">
                {preview.removals.map((removal) => (
                  <li key={removal.path} className="break-all">
                    <span className="text-muted">{formatBytes(removal.sizeBytes)}</span> {removal.path}
                  </li>
                ))}
                {preview.commands.map((command) => <li key={command} className="text-accent">$ {command}</li>)}
                {preview.removals.length === 0 && preview.commands.length === 0 && <li className="text-muted">Nothing to remove.</li>}
              </ul>
              <div className="mt-4 space-y-2 border-t border-warn/30 pt-3">
                <p className="text-xs text-warn">Type <code className="font-mono font-semibold">delete</code> to confirm. This cannot be undone.</p>
                <div className="flex gap-2">
                  <input className={`${inputClass} max-w-xs`} value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)} placeholder="delete" />
                  <Btn solid tone="bad" disabled={busy || confirmText.trim().toLowerCase() !== 'delete'} onClick={doRun}>Confirm delete</Btn>
                  <Btn disabled={busy} onClick={() => { setPreview(null); setConfirmText(''); }}>Cancel</Btn>
                </div>
              </div>
            </div>
          )}

          {result && (
            <div className="mt-4 rounded bg-surface p-4 text-xs">
              <p className="font-mono text-good">Reclaimed {formatBytes(result.reclaimedBytes)}</p>
              <ul className="mt-2 space-y-0.5 break-all font-mono text-inktext">
                {result.removed.map((path) => <li key={path}>removed {path}</li>)}
                {result.errors.map((error) => <li key={error} className="text-bad">{error}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
