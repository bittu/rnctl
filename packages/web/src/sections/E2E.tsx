import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { E2eFlow, E2eRun, E2eRunStarted, FrameworkId, FrameworkInfo, Platform } from '../rpc';
import { useDashboard } from '../App';
import { Btn, Empty, Field, KV, Panel, Pill, cut, inputClass, reasonText, type Tone } from '../ui';

const stateTone = (state: E2eRun['state']): Tone =>
  state === 'passed' ? 'good' : state === 'running' ? 'accent' : 'bad';

export default function E2ESection(): ReactNode {
  const { client, devices, notify } = useDashboard();
  const [frameworks, setFrameworks] = useState<FrameworkInfo[] | null>(null);
  const [selectedFramework, setSelectedFramework] = useState<FrameworkId | null>(null);
  const [flows, setFlows] = useState<E2eFlow[]>([]);
  const [selectedFlow, setSelectedFlow] = useState('');
  const [device, setDevice] = useState('');
  const [platform, setPlatform] = useState<Platform>('android');
  const [configuration, setConfiguration] = useState('ios.sim.debug');
  const [runs, setRuns] = useState<E2eRun[]>([]);
  const [details, setDetails] = useState<E2eRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(() => {
    void client.call<{ runs: E2eRun[] }>('e2e.status')
      .then((result) => setRuns(result.runs))
      .catch((reason: unknown) => notify(`e2e.status: ${reasonText(reason)}`, 'bad'));
  }, [client, notify]);

  useEffect(() => {
    let live = true;
    void client.call<{ frameworks: FrameworkInfo[] }>('e2e.frameworks')
      .then((result) => {
        if (!live) return;
        setFrameworks(result.frameworks);
        setSelectedFramework((current) => current ?? result.frameworks.find((item) => item.available)?.id ?? result.frameworks[0]?.id ?? null);
      })
      .catch((reason: unknown) => notify(`e2e.frameworks: ${reasonText(reason)}`, 'bad'));
    loadRuns();

    const offs = [
      client.on<E2eRunStarted>('e2e:run-started', () => { loadRuns(); }),
      client.on<E2eRun>('e2e:run-finished', (run) => {
        setRuns((current) => current.some((item) => item.runId === run.runId)
          ? current.map((item) => item.runId === run.runId ? run : item)
          : [run, ...current]);
        setDetails((current) => current?.runId === run.runId ? run : current);
      }),
    ];
    return () => { live = false; for (const off of offs) off(); };
  }, [client, loadRuns, notify]);

  useEffect(() => {
    if (!selectedFramework) return;
    let live = true;
    setFlows([]);
    setSelectedFlow('');
    void client.call<{ flows: E2eFlow[] }>('e2e.flows', { framework: selectedFramework })
      .then((result) => {
        if (!live) return;
        setFlows(result.flows);
        setSelectedFlow(result.flows[0]?.id ?? '');
      })
      .catch((reason: unknown) => notify(`e2e.flows: ${reasonText(reason)}`, 'bad'));
    return () => { live = false; };
  }, [client, notify, selectedFramework]);

  const activeFramework = frameworks?.find((item) => item.id === selectedFramework);
  const booted = devices.filter((item) => item.state === 'booted');

  const startRun = async (): Promise<void> => {
    if (!selectedFramework || !selectedFlow || !device.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.call<{ runId: string; started: boolean; reason?: string }>('e2e.run', {
        framework: selectedFramework,
        flow: selectedFlow,
        device: device.trim(),
        platform,
        configuration: configuration.trim() || 'ios.sim.debug',
      });
      if (!result.started) {
        const message = result.reason ?? 'The run was not started';
        setError(message);
        notify(message, 'warn');
        return;
      }
      notify(`Run ${result.runId} started`, 'good');
      loadRuns();
    } catch (reason: unknown) {
      const message = reasonText(reason);
      setError(message);
      notify(`e2e.run: ${message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const cancelRun = async (runId: string): Promise<void> => {
    try {
      await client.call<{ cancelled: boolean }>('e2e.cancel', { runId });
      notify(`Run ${runId} cancelled`, 'warn');
      loadRuns();
    } catch (reason: unknown) {
      notify(`e2e.cancel: ${reasonText(reason)}`, 'bad');
    }
  };

  const showDetails = async (runId: string): Promise<void> => {
    try {
      const response = await client.call<{ result: E2eRun | null } | E2eRun | null>('e2e.results', { runId });
      const result = response && !Array.isArray(response) && 'result' in response ? response.result : response;
      setDetails((result as E2eRun | null) ?? runs.find((item) => item.runId === runId) ?? null);
    } catch (reason: unknown) {
      notify(`e2e.results: ${reasonText(reason)}`, 'bad');
    }
  };

  return (
    <Panel title="E2E" subtitle={`${runs.length} run${runs.length === 1 ? '' : 's'} · ${flows.length} flows`}>
      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div>
          <h3 className="mb-2 font-display text-base font-semibold">Frameworks</h3>
          {frameworks === null ? (
            <p className="text-sm text-muted">Checking installed frameworks…</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {frameworks.map((framework) => (
                <button key={framework.id} type="button"
                  onClick={() => setSelectedFramework(framework.id)}
                  className={`rounded border p-3 text-left transition-colors ${selectedFramework === framework.id ? 'border-accent/60 bg-raised' : 'border-line bg-surface hover:border-line/80'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-sm font-semibold text-inktext">{framework.id}</span>
                    <Pill tone={framework.available ? 'good' : 'bad'}>{framework.available ? 'available' : 'missing'}</Pill>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted">{framework.version ?? framework.reason ?? '—'}</p>
                  {!framework.available && framework.installHint && (
                    <p className="mt-1 break-all font-mono text-[10px] text-warn">{framework.installHint}</p>
                  )}
                </button>
              ))}
            </div>
          )}

          <h3 className="mb-2 mt-6 font-display text-base font-semibold">Flows · {selectedFramework ?? '—'}</h3>
          {flows.length === 0 ? (
            <Empty>No flows found for {selectedFramework ?? 'this framework'}.</Empty>
          ) : (
            <div className="max-h-48 space-y-1 overflow-auto">
              {flows.map((flow) => (
                <button key={flow.id} type="button" onClick={() => setSelectedFlow(flow.id)}
                  className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left transition-colors ${selectedFlow === flow.id ? 'bg-raised' : 'hover:bg-surface'}`}>
                  <span className="min-w-0 flex-1 truncate text-sm text-inktext">{flow.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted" title={flow.path}>{cut(flow.path, 34)}</span>
                </button>
              ))}
            </div>
          )}

          <h3 className="mb-2 mt-6 font-display text-base font-semibold">New run</h3>
          <div className="space-y-3">
            <Field label="Flow" hint={selectedFlow || 'Select a flow above'}>
              <input className={inputClass} value={selectedFlow} onChange={(event) => setSelectedFlow(event.target.value)}
                placeholder="e2e/login.yaml" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Device">
                <input className={inputClass} list="e2e-device-ids" value={device} onChange={(event) => setDevice(event.target.value)}
                  placeholder="simulator id / serial" />
                <datalist id="e2e-device-ids">
                  {booted.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </datalist>
              </Field>
              <Field label="Platform">
                <select className={inputClass} value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>
                  <option value="android">android</option>
                  <option value="ios">ios</option>
                </select>
              </Field>
            </div>
            <Field label="Detox configuration">
              <input className={inputClass} value={configuration} onChange={(event) => setConfiguration(event.target.value)} />
            </Field>
            <Btn solid tone="accent" disabled={busy || !activeFramework?.available || !selectedFlow.trim() || !device.trim()}
              onClick={() => void startRun()}>
              Run flow
            </Btn>
            {!activeFramework?.available && <p className="text-[11px] text-warn">{activeFramework?.reason ?? 'Framework is not available.'}</p>}
            {error && <p className="rounded bg-bad/10 px-3 py-2 font-mono text-xs text-bad">{error}</p>}
          </div>
        </div>

        <div>
          <h3 className="mb-2 font-display text-base font-semibold">Runs</h3>
          {runs.length === 0 ? (
            <Empty>No runs yet. Start a flow to see live results.</Empty>
          ) : (
            <div className="max-h-72 overflow-auto rounded border border-line">
              <table className="w-full border-collapse text-left font-mono text-xs">
                <thead className="sticky top-0 bg-surface text-muted">
                  <tr className="border-b border-line">
                    <th className="px-3 py-2 font-normal">id</th>
                    <th className="px-3 py-2 font-normal">flow</th>
                    <th className="px-3 py-2 font-normal">state</th>
                    <th className="px-3 py-2 font-normal">summary</th>
                    <th className="px-3 py-2 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.runId} className={`border-b border-line/50 ${details?.runId === run.runId ? 'bg-raised' : ''}`}>
                      <td className="px-3 py-1.5 text-accent">{run.runId}</td>
                      <td className="px-3 py-1.5 text-inktext" title={run.flow}>{cut(run.flow, 24)}</td>
                      <td className="px-3 py-1.5"><Pill tone={stateTone(run.state)}>{run.state}</Pill></td>
                      <td className="px-3 py-1.5 text-muted" title={run.summary ?? ''}>{cut(run.summary ?? run.error ?? '—', 48)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <div className="flex justify-end gap-1">
                          {run.state === 'running' && <Btn disabled={busy} onClick={() => void cancelRun(run.runId)}>Cancel</Btn>}
                          <Btn onClick={() => void showDetails(run.runId)}>Details</Btn>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {details && (
            <div className="mt-4 rounded bg-surface p-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <span className="font-display text-sm font-semibold text-inktext">Run {details.runId}</span>
                <Pill tone={stateTone(details.state)}>{details.state}</Pill>
              </div>
              <KV label="framework" value={details.framework} />
              <KV label="flow" value={cut(details.flow, 40)} />
              <KV label="device" value={cut(details.device, 28)} />
              <KV label="platform" value={details.platform} />
              {details.configuration && <KV label="configuration" value={details.configuration} />}
              {details.exitCode !== undefined && <KV label="exit code" value={String(details.exitCode)} tone={details.exitCode === 0 ? 'good' : 'bad'} />}
              {details.summary && (
                <p className="mt-3 whitespace-pre-wrap break-all font-mono text-[11px] text-inktext" title={details.summary}>
                  {cut(details.summary, 240)}
                </p>
              )}
              {details.error && <p className="mt-3 font-mono text-[11px] text-bad">{details.error}</p>}
              <h4 className="mb-1 mt-4 font-mono text-[11px] uppercase tracking-wider text-muted">Screenshots</h4>
              {details.screenshots.length === 0 ? (
                <p className="text-xs text-muted">None reported.</p>
              ) : (
                <ul className="space-y-0.5 font-mono text-[11px] text-accent">
                  {details.screenshots.map((path) => <li key={path} className="break-all" title={path}>{cut(path, 72)}</li>)}
                </ul>
              )}
              <KV label="artifacts" value={cut(details.artifactsDir, 40)} />
            </div>
          )}
          <p className={`mt-3 text-[11px] ${'text-muted'}`}>Run state and screenshots come from daemon events and e2e.status.</p>
        </div>
      </div>
    </Panel>
  );
}
