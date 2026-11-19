import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FpsSample, PerfCrash } from '../rpc';
import { useDashboard } from '../App';
import { Btn, Empty, Field, Panel, Pill, clock, inputClass, reasonText } from '../ui';

export default function PerfSection(): ReactNode {
  const { client, notify, fpsSamples } = useDashboard();
  const [crashes, setCrashes] = useState<PerfCrash[] | null>(null);
  const [selectedCrash, setSelectedCrash] = useState<string | null>(null);
  const [initialSamples, setInitialSamples] = useState<FpsSample[]>([]);
  const [fpsApp, setFpsApp] = useState('');
  const [sampling, setSampling] = useState(false);
  const [sourcemap, setSourcemap] = useState('');
  const [stack, setStack] = useState('');
  const [symbolicated, setSymbolicated] = useState<{ ok: boolean; text: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      setCrashes([]);
      setMessage('Crash buffer unavailable (timed out)');
    }, 3000);
    const finish = (): void => { settled = true; clearTimeout(timer); };
    void client.call<{ crashes: PerfCrash[] }>('perf.crashes', { limit: 50 })
      .then((result) => { if (!settled) { finish(); setCrashes(result.crashes); } })
      .catch((reason: unknown) => {
        if (settled) return;
        finish();
        setCrashes([]);
        notify(`perf.crashes: ${reasonText(reason)}`, 'bad');
      });
    void client.call<{ samples: FpsSample[] }>('perf.fpsSamples', { limit: 200 })
      .then((result) => setInitialSamples(result.samples))
      .catch((reason: unknown) => notify(`perf.fpsSamples: ${reasonText(reason)}`, 'bad'));
    return () => { clearTimeout(timer); void client.call('perf.fpsStop').catch(() => { /* best effort */ }); };
  }, [client, notify]);

  const samples = useMemo(() => {
    const seen = new Set<string>();
    return [...initialSamples, ...fpsSamples].filter((sample) => !seen.has(sample.id) && Boolean(seen.add(sample.id)));
  }, [initialSamples, fpsSamples]);
  const crash = crashes?.find((item) => item.id === selectedCrash) ?? crashes?.[0];

  const toggleSampling = (): void => {
    if (sampling) {
      void client.call<{ stopped: boolean }>('perf.fpsStop')
        .then((result) => { setSampling(false); notify(result.stopped ? 'FPS sampling stopped' : 'Sampling was not running', 'good'); })
        .catch((reason: unknown) => notify(`perf.fpsStop: ${reasonText(reason)}`, 'bad'));
      return;
    }
    if (!fpsApp.trim()) { setMessage('Enter an Android package to sample.'); return; }
    setBusy(true);
    void client.call<{ started: boolean; reason?: string }>('perf.fpsStart', { app: fpsApp.trim() })
      .then((result) => {
        setMessage(result.reason ?? null);
        if (result.started) { setSampling(true); notify(`Sampling ${fpsApp.trim()}`, 'good'); }
        else notify(result.reason ?? 'FPS sampling could not start', 'warn');
      })
      .catch((reason: unknown) => notify(`perf.fpsStart: ${reasonText(reason)}`, 'bad'))
      .finally(() => setBusy(false));
  };

  const symbolicate = (): void => {
    if (!sourcemap.trim() || !stack.trim()) { setMessage('A source map path and a stack trace are both required.'); return; }
    setBusy(true);
    void client.call<{ available: boolean; reason?: string; symbolicated?: string }>('perf.symbolicate', {
      sourcemap: sourcemap.trim(), stack,
    })
      .then((result) => {
        setSymbolicated({
          ok: Boolean(result.available),
          text: result.available ? result.symbolicated ?? '' : result.reason ?? 'Symbolication failed',
        });
      })
      .catch((reason: unknown) => notify(`perf.symbolicate: ${reasonText(reason)}`, 'bad'))
      .finally(() => setBusy(false));
  };

  return (
    <Panel title="Perf" subtitle={`${crashes?.length ?? '…'} crashes · ${samples.length} fps samples`}>
      <div className="grid gap-8 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 font-display text-base font-semibold">Crashes</h3>
          {!crashes ? <p className="text-sm text-muted">Reading crash buffers…</p> : crashes.length === 0 ? (
            <Empty>No crash reports found on this device.</Empty>
          ) : (
            <div className="max-h-64 space-y-1 overflow-auto">
              {crashes.map((item) => (
                <button key={item.id} type="button" onClick={() => setSelectedCrash(item.id)}
                  className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left ${crash?.id === item.id ? 'bg-raised' : 'hover:bg-surface'}`}>
                  <Pill tone={item.platform === 'ios' ? 'accent' : 'good'}>{item.platform}</Pill>
                  <Pill tone={item.kind === 'js' ? 'warn' : 'bad'}>{item.kind}</Pill>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-inktext">{item.app}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{clock(item.timestamp)}</span>
                </button>
              ))}
            </div>
          )}
          {crash && (
            <div className="mt-3 rounded bg-surface p-3">
              <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted">{crash.source} · {crash.app}</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-inktext">{crash.excerpt}</pre>
              {crash.frames.length > 0 && (
                <Btn className="mt-3" onClick={() => { setStack(crash.frames.join('\n')); setMessage('Stack copied into the symbolication form below.'); }}>
                  Use frames in symbolication
                </Btn>
              )}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 font-display text-base font-semibold">FPS samples</h3>
          <div className="flex gap-2">
            <input className={inputClass} value={fpsApp} onChange={(event) => setFpsApp(event.target.value)}
              placeholder="com.example.app" aria-label="Android package" />
            <Btn solid tone={sampling ? 'bad' : 'good'} disabled={busy} onClick={toggleSampling}>
              {sampling ? 'Stop' : 'Start'}
            </Btn>
          </div>
          <p className="mt-1 text-[11px] text-muted">Android only · samples arrive live from the daemon.</p>
          <div className="mt-3 max-h-52 overflow-auto rounded border border-line">
            {samples.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted">No samples yet.</p>
            ) : (
              <table className="w-full border-collapse text-left font-mono text-xs">
                <thead className="sticky top-0 bg-surface text-muted">
                  <tr className="border-b border-line">
                    <th className="px-3 py-2 font-normal">time</th><th className="px-3 py-2 font-normal">fps</th>
                    <th className="px-3 py-2 font-normal">janky</th><th className="px-3 py-2 font-normal">p90</th><th className="px-3 py-2 font-normal">p95</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.map((sample) => (
                    <tr key={sample.id} className="border-b border-line/50">
                      <td className="px-3 py-1.5 text-muted">{clock(sample.timestamp)}</td>
                      <td className="px-3 py-1.5 text-accent">{sample.uiFps ?? '—'}</td>
                      <td className="px-3 py-1.5 text-warn">{sample.jankyPct === undefined ? '—' : `${sample.jankyPct}%`}</td>
                      <td className="px-3 py-1.5 text-inktext">{sample.p90Ms ?? '—'}</td>
                      <td className="px-3 py-1.5 text-inktext">{sample.p95Ms ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <h3 className="mb-2 mt-7 font-display text-base font-semibold">Symbolicate</h3>
          <div className="space-y-3">
            <Field label="Source map path">
              <input className={inputClass} value={sourcemap} onChange={(event) => setSourcemap(event.target.value)}
                placeholder="/path/to/index.android.bundle.map" />
            </Field>
            <Field label="Stack trace">
              <textarea className={`${inputClass} min-h-24 resize-y`} value={stack} onChange={(event) => setStack(event.target.value)}
                placeholder="at Component.render (index.android.bundle:123:45)" />
            </Field>
            <Btn disabled={busy || !sourcemap.trim() || !stack.trim()} onClick={symbolicate}>Symbolicate</Btn>
          </div>
          {symbolicated && (
            <pre className={`mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded p-3 font-mono text-[11px] ${symbolicated.ok ? 'bg-good/10 text-good' : 'bg-bad/10 text-bad'}`}>
              {symbolicated.text}
            </pre>
          )}
          {message && <p className="mt-3 text-xs text-muted">{message}</p>}
          <p className="mt-3 text-[11px] text-muted">Stack frames are symbolicated by metro-symbolicate on the daemon.</p>
        </div>
      </div>
    </Panel>
  );
}
