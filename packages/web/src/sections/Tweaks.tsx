import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Platform, TweakAppliedEvent, TweakDevice, TweakResetEvent, TweakResult } from '../rpc';
import { useDashboard } from '../App';
import { Btn, Empty, Field, KV, Panel, Pill, TONE_CLASS, clock, cut, inputClass, reasonText, type Tone } from '../ui';

type TweakAction = 'location' | 'appearance' | 'statusBar' | 'network' | 'battery' | 'push' | 'all';
const RESET_KINDS: TweakAction[] = ['location', 'appearance', 'statusBar', 'network', 'battery', 'all'];
const NETWORK_PROFILES = ['gsm', 'edge', 'umts', 'hsdpa', 'lte', 'full'] as const;

/** Mirrors the availability rules enforced by the daemon; the daemon still decides the final result. */
const GATE: Record<TweakAction, (device: TweakDevice) => string | null> = {
  location: (device) => device.platform === 'android' && !device.isEmulator ? 'GPS injection is emulator-only' : null,
  appearance: () => null,
  statusBar: (device) => device.platform !== 'ios' ? 'Status bar overrides are iOS-only' : null,
  network: (device) => device.platform !== 'android' || !device.isEmulator ? 'Network throttle is Android emulator-only' : null,
  battery: (device) => device.platform !== 'android' ? 'Battery override is Android-only' : null,
  push: (device) => device.platform !== 'ios' ? 'Mock push is iOS-only' : null,
  all: () => null,
};

interface Outcome {
  label: string;
  results: TweakResult[];
  ok: boolean;
}

interface Activity {
  id: number;
  text: string;
  tone: Tone;
}

export default function TweaksSection(): ReactNode {
  const { client, notify } = useDashboard();
  const [devices, setDevices] = useState<TweakDevice[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lat, setLat] = useState('37.7749');
  const [lon, setLon] = useState('-122.4194');
  const [network, setNetwork] = useState<string>('lte');
  const [battery, setBattery] = useState('50');
  const [bundleId, setBundleId] = useState('');
  const [payload, setPayload] = useState('{\n  "aps": {\n    "alert": "Hello from rnctl"\n  }\n}');
  const [resetKind, setResetKind] = useState<TweakAction>('all');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false);
  const activityId = useRef(0);

  const refresh = useCallback(() => {
    void client.call<{ devices: TweakDevice[] }>('tweaks.devices')
      .then((result) => setDevices(result.devices))
      .catch((reason: unknown) => notify(`tweaks.devices: ${reasonText(reason)}`, 'bad'));
  }, [client, notify]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const record = (text: string, tone: Tone): void => {
      activityId.current += 1;
      setActivity((current) => [{ id: activityId.current, text, tone }, ...current].slice(0, 8));
    };
    const offs = [
      client.on<TweakAppliedEvent>('tweak:applied', (event) => {
        const tone: Tone = event.status === 'applied' ? 'good' : event.status === 'unavailable' ? 'warn' : 'bad';
        record(`${clock(Date.now())} ${event.kind} · ${cut(event.id, 18)} · ${event.status}`, tone);
      }),
      client.on<TweakResetEvent>('tweak:reset', (event) => {
        record(`${clock(Date.now())} reset:${event.kind} · ${cut(event.id, 18)}`, 'muted');
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [client]);

  const groups: Array<{ platform: Platform; label: string; devices: TweakDevice[] }> = (['ios', 'android'] as const).map((platform) => ({
    platform,
    label: platform === 'ios' ? 'iOS' : 'Android',
    devices: (devices ?? [])
      .filter((device) => device.platform === platform && device.booted !== false && device.state !== 'shutdown')
      .sort((a, b) => a.id.localeCompare(b.id)),
  }));
  const ordered = groups.flatMap((group) => group.devices);
  const selected = ordered.find((device) => device.id === selectedId) ?? ordered[0];
  const gate = (action: TweakAction): string | null => selected ? GATE[action](selected) : 'Select a device first';

  const invoke = async (method: string, params: Record<string, unknown>, label: string, reset = false): Promise<void> => {
    setBusy(true);
    try {
      const raw = await client.call<Record<string, unknown>>(method, params);
      const results = reset
        ? ((raw.results as TweakResult[] | undefined) ?? [])
        : [raw as unknown as TweakResult];
      const ok = Boolean(raw.ok);
      setOutcome({ label, results, ok });
      const detail = results.map((item) => item.message).filter(Boolean).join('; ');
      notify(`${label}: ${ok ? 'ok' : detail || 'failed'}`, ok ? 'good' : 'warn');
    } catch (reason: unknown) {
      const message = reasonText(reason);
      setOutcome({
        label,
        results: [{ id: selected?.id ?? '', platform: selected?.platform ?? 'ios', ok: false, message, status: 'error' }],
        ok: false,
      });
      notify(`${method}: ${message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const applyLocation = (): void => {
    const value = { lat: Number(lat), lon: Number(lon) };
    if (!Number.isFinite(value.lat) || Math.abs(value.lat) > 90 || !Number.isFinite(value.lon) || Math.abs(value.lon) > 180) {
      setOutcome({ label: 'Location', results: [{ id: selected?.id ?? '', platform: selected?.platform ?? 'ios', ok: false, message: 'Latitude must be -90..90 and longitude -180..180', status: 'error' }], ok: false });
      return;
    }
    void invoke('tweaks.location.set', { id: selected?.id, platform: selected?.platform, ...value }, 'Location');
  };

  const sendPush = (): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setOutcome({ label: 'Mock push', results: [{ id: selected?.id ?? '', platform: selected?.platform ?? 'ios', ok: false, message: 'Payload must be a JSON object', status: 'error' }], ok: false });
      return;
    }
    void invoke('tweaks.push.send', {
      id: selected?.id, platform: selected?.platform, bundleId: bundleId.trim(), payload: parsed,
    }, 'Mock push');
  };

  return (
    <Panel
      title="Tweaks"
      subtitle={`${ordered.length} booted device${ordered.length === 1 ? '' : 's'}`}
      right={<Btn disabled={busy} onClick={refresh}>Refresh</Btn>}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 lg:flex-row">
        <div className="min-h-0 flex-1 space-y-5">
          {devices === null ? (
            <p className="text-sm text-muted">Reading booted devices…</p>
          ) : ordered.length === 0 ? (
            <Empty>No booted simulators or emulators found.</Empty>
          ) : groups.map((group) => group.devices.length > 0 && (
            <div key={group.platform}>
              <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                {group.label} · {group.devices.length}
              </h3>
              <div className="space-y-1">
                {group.devices.map((device) => (
                  <button key={device.id} type="button" onClick={() => { setSelectedId(device.id); setOutcome(null); }}
                    className={`flex w-full items-center gap-3 rounded px-3 py-2.5 text-left transition-colors ${selected?.id === device.id ? 'bg-raised' : 'hover:bg-surface'}`}>
                    <span className="h-2 w-2 shrink-0 rounded-full bg-good" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-inktext">{cut(device.id, 36)}</span>
                    {!device.isEmulator && <Pill tone="warn">physical</Pill>}
                    <Pill tone={device.platform === 'ios' ? 'accent' : 'good'}>{device.platform}</Pill>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <aside className="w-full shrink-0 border-line lg:w-[22rem] lg:border-l lg:pl-5">
          <h3 className="mb-1 font-display text-base font-semibold text-inktext">Actions</h3>
          {!selected ? (
            <p className="text-sm text-muted">Select a booted device to see its available tweaks.</p>
          ) : (
            <>
              <div className="mb-4 rounded bg-surface px-3 py-2">
                <KV label="device" value={cut(selected.id, 28)} />
                <KV label="platform" value={selected.platform} tone="accent" />
                <KV label="kind" value={selected.isEmulator ? 'emulator / simulator' : 'physical device'} />
              </div>

              <div className="max-h-[calc(100vh-15rem)] space-y-5 overflow-y-auto pr-1">
                <section>
                  <h4 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted">Location</h4>
                  <div className="flex gap-2">
                    <input className={inputClass} aria-label="Latitude" value={lat} onChange={(event) => setLat(event.target.value)} placeholder="latitude" />
                    <input className={inputClass} aria-label="Longitude" value={lon} onChange={(event) => setLon(event.target.value)} placeholder="longitude" />
                    <Btn disabled={busy || gate('location') !== null} onClick={applyLocation}>Set</Btn>
                  </div>
                  {gate('location') && <p className="mt-1 text-[11px] text-warn">{gate('location')}</p>}
                </section>

                <section>
                  <h4 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted">Appearance</h4>
                  <div className="flex gap-2">
                    <Btn disabled={busy} onClick={() => void invoke('tweaks.appearance.set', { id: selected.id, platform: selected.platform, mode: 'dark' }, 'Appearance dark')}>Dark</Btn>
                    <Btn disabled={busy} onClick={() => void invoke('tweaks.appearance.set', { id: selected.id, platform: selected.platform, mode: 'light' }, 'Appearance light')}>Light</Btn>
                  </div>
                </section>

                <section>
                  <h4 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted">Status bar</h4>
                  <Btn disabled={busy || gate('statusBar') !== null}
                    onClick={() => void invoke('tweaks.statusBar.set', { id: selected.id, platform: selected.platform, preset: 'clean' }, 'Clean status bar')}>
                    Clean (9:41)
                  </Btn>
                  {gate('statusBar') && <p className="mt-1 text-[11px] text-warn">{gate('statusBar')}</p>}
                </section>

                <section>
                  <h4 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted">Network</h4>
                  <div className="flex gap-2">
                    <select className={inputClass} aria-label="Network profile" value={network} onChange={(event) => setNetwork(event.target.value)}>
                      {NETWORK_PROFILES.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
                    </select>
                    <Btn disabled={busy || gate('network') !== null}
                      onClick={() => void invoke('tweaks.network.set', { id: selected.id, platform: selected.platform, profile: network }, `Network ${network}`)}>
                      Apply
                    </Btn>
                  </div>
                  {gate('network') && <p className="mt-1 text-[11px] text-warn">{gate('network')}</p>}
                </section>

                <section>
                  <h4 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted">Battery</h4>
                  <div className="flex gap-2">
                    <input className={inputClass} aria-label="Battery level" type="number" min={0} max={100} value={battery} onChange={(event) => setBattery(event.target.value)} />
                    <Btn disabled={busy || gate('battery') !== null}
                      onClick={() => {
                        const level = Number(battery);
                        if (!Number.isInteger(level) || level < 0 || level > 100) {
                          setOutcome({ label: 'Battery', results: [{ id: selected.id, platform: selected.platform, ok: false, message: 'Level must be an integer 0..100', status: 'error' }], ok: false });
                          return;
                        }
                        void invoke('tweaks.battery.set', { id: selected.id, platform: selected.platform, level }, `Battery ${level}%`);
                      }}>
                      Set
                    </Btn>
                  </div>
                  {gate('battery') && <p className="mt-1 text-[11px] text-warn">{gate('battery')}</p>}
                </section>

                <section>
                  <h4 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted">Mock push</h4>
                  <div className="space-y-2">
                    <Field label="Bundle ID">
                      <input className={inputClass} value={bundleId} onChange={(event) => setBundleId(event.target.value)} placeholder="com.example.app" />
                    </Field>
                    <Field label="APNs payload (JSON)">
                      <textarea className={`${inputClass} min-h-20 resize-y`} value={payload} onChange={(event) => setPayload(event.target.value)} />
                    </Field>
                    <Btn disabled={busy || gate('push') !== null || !bundleId.trim()} onClick={sendPush}>Send push</Btn>
                    {gate('push') && <p className="text-[11px] text-warn">{gate('push')}</p>}
                  </div>
                </section>

                <section>
                  <h4 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted">Reset</h4>
                  <div className="flex gap-2">
                    <select className={inputClass} aria-label="Reset target" value={resetKind} onChange={(event) => setResetKind(event.target.value as TweakAction)}>
                      {RESET_KINDS.map((kind) => {
                        const reason = GATE[kind](selected);
                        return <option key={kind} value={kind} disabled={reason !== null}>{kind}{reason ? ' (unavailable)' : ''}</option>;
                      })}
                    </select>
                    <Btn disabled={busy} onClick={() => void invoke('tweaks.reset', { id: selected.id, platform: selected.platform, what: resetKind }, `Reset ${resetKind}`, true)}>Reset</Btn>
                  </div>
                  <p className="mt-1 text-[11px] text-muted">Unsupported kinds are skipped by the daemon.</p>
                </section>
              </div>

              {outcome && (
                <div className={`mt-4 rounded p-3 ${outcome.ok ? 'bg-good/10' : 'bg-bad/10'}`}>
                  <p className={`mb-1 font-mono text-[11px] ${outcome.ok ? 'text-good' : 'text-bad'}`}>
                    {outcome.label} · {outcome.ok ? 'ok' : 'failed'}
                  </p>
                  {outcome.results.length === 0 ? (
                    <p className="text-xs text-muted">No changes were applied.</p>
                  ) : outcome.results.map((item, index) => (
                    <p key={`${item.id}-${index}`} className={`flex gap-2 font-mono text-[11px] ${TONE_CLASS[item.status === 'applied' ? 'good' : item.status === 'unavailable' ? 'warn' : 'bad']}`}>
                      <span>{item.status}</span>
                      <span className="min-w-0 break-all">{item.message || '(no message)'}</span>
                    </p>
                  ))}
                </div>
              )}

              {activity.length > 0 && (
                <div className="mt-4">
                  <h4 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted">Recent activity</h4>
                  <ul className="space-y-0.5 font-mono text-[11px]">
                    {activity.map((entry) => <li key={entry.id} className={TONE_CLASS[entry.tone]}>{entry.text}</li>)}
                  </ul>
                </div>
              )}
              <p className={`mt-3 text-[11px] ${TONE_CLASS.muted}`}>Results come from the daemon; no status is assumed.</p>
            </>
          )}
        </aside>
      </div>
    </Panel>
  );
}
