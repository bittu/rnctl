import { useEffect, useState, type ReactNode } from 'react';
import type { Device, Platform } from '../rpc';
import { useDashboard } from '../App';
import { Btn, Empty, Field, KV, Pill, Panel, TONE_CLASS, cut, inputClass, reasonText } from '../ui';

interface Result { ok: boolean; message: string }

export default function DevicesSection(): ReactNode {
  const { client, devices, deviceFilter, setDeviceFilter, refreshDevices, notify, metro } = useDashboard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [app, setApp] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = devices.filter((device) => deviceFilter === 'all' || device.platform === deviceFilter);
  const groups: Array<{ platform: Platform; devices: Device[] }> = (['ios', 'android'] as const).map((platform) => ({
    platform,
    devices: visible.filter((device) => device.platform === platform)
      .sort((a, b) => Number(b.state === 'booted') - Number(a.state === 'booted') || a.name.localeCompare(b.name)),
  }));
  const ordered = groups.flatMap((group) => group.devices);
  const selected = ordered.find((device) => device.id === selectedId) ?? ordered[0];
  const booted = visible.filter((device) => device.state === 'booted').length;

  useEffect(() => { refreshDevices(); }, [refreshDevices]);

  const invoke = async (method: string, params: Record<string, unknown>, label: string, after?: () => void): Promise<void> => {
    setBusy(true);
    try {
      const outcome = await client.call<Record<string, unknown>>(method, params);
      const flag = outcome.ok ?? outcome.sent ?? outcome.started;
      const ok = flag === undefined ? true : Boolean(flag);
      const message = typeof outcome.message === 'string' && outcome.message
        ? outcome.message
        : ok ? `${label} succeeded` : `${label} was refused`;
      setResult({ ok, message });
      notify(`${label}: ${message}`, ok ? 'good' : 'warn');
      after?.();
    } catch (reason: unknown) {
      const message = reasonText(reason);
      setResult({ ok: false, message });
      notify(`${method}: ${message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Devices"
      subtitle={`${visible.length} shown · ${booted} booted`}
      right={
        <div className="flex gap-1">
          {(['all', 'ios', 'android'] as const).map((filter) => (
            <Btn key={filter} onClick={() => setDeviceFilter(filter)} className={deviceFilter === filter ? 'ring-1 ring-accent/60' : ''}>
              {filter === 'all' ? 'All' : filter === 'ios' ? 'iOS' : 'Android'}
            </Btn>
          ))}
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 lg:flex-row">
        <div className="min-h-0 flex-1 space-y-5">
          {ordered.length === 0 && <Empty>No devices found. Connect an emulator or boot a simulator.</Empty>}
          {groups.map((group) => group.devices.length > 0 && (
            <div key={group.platform}>
              <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                {group.platform === 'ios' ? 'iOS' : 'Android'} · {group.devices.length}
              </h3>
              <div className="space-y-1">
                {group.devices.map((device) => {
                  const isSelected = selected?.id === device.id;
                  return (
                    <button
                      key={device.id}
                      type="button"
                      onClick={() => { setSelectedId(device.id); setResult(null); }}
                      className={`flex w-full items-center gap-3 rounded px-3 py-2.5 text-left transition-colors ${isSelected ? 'bg-raised' : 'hover:bg-surface'}`}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${device.state === 'booted' ? 'bg-good' : 'bg-muted/60'}`} />
                      <span className="min-w-0 flex-1 truncate text-sm text-inktext">{device.name}</span>
                      <span className="hidden font-mono text-[11px] text-muted sm:inline">{cut(device.id, 22)}</span>
                      <Pill tone={device.state === 'booted' ? 'good' : 'muted'}>{device.state}</Pill>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <aside className="w-full shrink-0 border-line lg:w-80 lg:border-l lg:pl-5">
          <h3 className="mb-1 font-display text-base font-semibold text-inktext">Actions</h3>
          {!selected ? (
            <p className="text-sm text-muted">Select a device to see its actions.</p>
          ) : (
            <>
              <div className="mb-4 rounded bg-surface px-3 py-2">
                <KV label="device" value={cut(selected.name, 28)} />
                <KV label="platform" value={selected.platform} tone="accent" />
                <KV label="state" value={selected.state} tone={selected.state === 'booted' ? 'good' : 'warn'} />
                <KV label="metro" value={metro.status} tone={metro.status === 'running' ? 'good' : 'muted'} />
              </div>

              <div className="flex flex-wrap gap-2">
                {selected.state === 'booted' ? (
                  <Btn solid tone="bad" disabled={busy}
                    onClick={() => void invoke('devices.shutdown', { id: selected.id, platform: selected.platform }, 'Shutdown', refreshDevices)}>
                    Shutdown
                  </Btn>
                ) : (
                  <Btn solid tone="good" disabled={busy}
                    onClick={() => void invoke('devices.boot', { id: selected.id, platform: selected.platform }, 'Boot', refreshDevices)}>
                    Boot
                  </Btn>
                )}
                <Btn disabled={busy} onClick={() => void invoke('metro.reload', {}, 'Reload')}>Reload JS</Btn>
                <Btn disabled={busy} onClick={() => void invoke('metro.devMenu', {}, 'Dev menu')}>Dev menu</Btn>
              </div>

              <div className="mt-5 space-y-4">
                <Field label="Install app" hint="Path to a .app (iOS) or .apk (Android)">
                  <div className="flex gap-2">
                    <input className={inputClass} value={path} onChange={(event) => setPath(event.target.value)}
                      placeholder="/path/to/app.apk" />
                    <Btn disabled={busy || !path} onClick={() => void invoke('devices.installApp', { id: selected.id, platform: selected.platform, path }, 'Install')}>
                      Install
                    </Btn>
                  </div>
                </Field>
                <Field label="Run app" hint="Bundle identifier or Android package">
                  <div className="flex gap-2">
                    <input className={inputClass} value={app} onChange={(event) => setApp(event.target.value)}
                      placeholder="com.example.app" />
                    <Btn disabled={busy || !app} onClick={() => void invoke('devices.runApp', { id: selected.id, platform: selected.platform, app }, 'Run')}>
                      Run
                    </Btn>
                  </div>
                </Field>
              </div>

              {result && (
                <p className={`mt-5 rounded px-3 py-2 font-mono text-xs ${result.ok ? 'bg-good/10 text-good' : 'bg-bad/10 text-bad'}`}>
                  {result.message}
                </p>
              )}
              <p className={`mt-3 text-[11px] ${TONE_CLASS.muted}`}>Results come from the daemon; no status is assumed.</p>
            </>
          )}
        </aside>
      </div>
    </Panel>
  );
}
