import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react';
import {
  WebRpcClient, type Device, type FpsSample, type LogEntry, type NetworkEntry,
  type ProcessExit, type ProjectInfo,
} from './rpc';
import { Icon, TONE_CLASS, reasonText, redactEntry, type Tone } from './ui';
import DevicesSection from './sections/Devices';
import LogsSection from './sections/Logs';
import MetroSection from './sections/Metro';
import EnvironmentSection from './sections/Environment';
import BroadcastSection from './sections/Broadcast';
import StorageSection from './sections/Storage';
import PerfSection from './sections/Perf';
import TweaksSection from './sections/Tweaks';
import E2ESection from './sections/E2E';

type ScreenId = 'devices' | 'logs' | 'metro' | 'environment' | 'broadcast' | 'storage' | 'perf' | 'tweaks' | 'e2e';
export type DeviceFilter = 'all' | 'ios' | 'android';
type MetroState = { status: 'unknown' | 'running' | 'stopped'; pid?: number };

const MAX_LIVE = 200;
const SCREENS: ReadonlyArray<{ id: ScreenId; label: string; key: string }> = [
  { id: 'devices', label: 'Devices', key: '1' },
  { id: 'logs', label: 'Logs', key: '2' },
  { id: 'metro', label: 'Metro', key: '3' },
  { id: 'environment', label: 'Environment', key: '4' },
  { id: 'broadcast', label: 'Broadcast', key: '5' },
  { id: 'storage', label: 'Storage', key: '6' },
  { id: 'perf', label: 'Perf', key: '7' },
  { id: 'tweaks', label: 'Tweaks', key: '8' },
  { id: 'e2e', label: 'E2E', key: '9' },
];

interface DashboardContextValue {
  client: WebRpcClient;
  notify: (text: string, tone?: Tone) => void;
  devices: Device[];
  refreshDevices: () => void;
  deviceFilter: DeviceFilter;
  setDeviceFilter: (filter: DeviceFilter) => void;
  project: ProjectInfo | null;
  refreshProject: () => void;
  entries: LogEntry[];
  clearEntries: () => void;
  networkEntries: NetworkEntry[];
  fpsSamples: FpsSample[];
  metro: MetroState;
  setMetro: (metro: MetroState) => void;
  open: (screen: ScreenId) => void;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

/** Sections read shared daemon state from here; state stays alive across screen switches. */
export function useDashboard(): DashboardContextValue {
  const value = useContext(DashboardContext);
  if (!value) throw new Error('useDashboard requires a Dashboard provider');
  return value;
}

export default function App(): ReactNode {
  const [client, setClient] = useState<WebRpcClient | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let connected: WebRpcClient | undefined;
    void WebRpcClient.connect()
      .then((webClient) => {
        if (!live) { webClient.close(); return; }
        connected = webClient;
        setClient(webClient);
      })
      .catch((reason: unknown) => { if (live) setConnectionError(reasonText(reason)); });
    return () => { live = false; connected?.close(); };
  }, []);

  if (connectionError) {
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-3 bg-ink px-6 text-center text-inktext">
        <span className="font-display text-2xl text-bad">Dashboard offline</span>
        <p className="max-w-md text-sm text-muted">{connectionError}</p>
        <p className="font-mono text-xs text-muted">Start the daemon with rnctl, then reload this page.</p>
      </main>
    );
  }
  if (!client) {
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-3 bg-ink text-inktext">
        <span className="font-display text-2xl text-accent">◆ rnctl</span>
        <span className="font-mono text-xs text-muted">connecting to daemon…</span>
      </main>
    );
  }
  return <Dashboard client={client} />;
}

function Dashboard({ client }: { client: WebRpcClient }): ReactNode {
  const [active, setActive] = useState<ScreenId>('devices');
  const [visited, setVisited] = useState<Set<ScreenId>>(() => new Set<ScreenId>(['devices']));
  const [toast, setToast] = useState<{ text: string; tone: Tone }>({ text: 'ready', tone: 'muted' });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceFilter, setDeviceFilter] = useState<DeviceFilter>('all');
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [networkEntries, setNetworkEntries] = useState<NetworkEntry[]>([]);
  const [fpsSamples, setFpsSamples] = useState<FpsSample[]>([]);
  const [metro, setMetro] = useState<MetroState>({ status: 'unknown' });

  const notify = useCallback((text: string, tone: Tone = 'muted') => {
    setToast({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast({ text: 'ready', tone: 'muted' }), 6000);
  }, []);

  const refreshDevices = useCallback(() => {
    void client.call<{ devices: Device[] }>('devices.list')
      .then((result) => setDevices(result.devices))
      .catch((reason: unknown) => notify(`devices.list: ${reasonText(reason)}`, 'bad'));
  }, [client, notify]);

  const refreshProject = useCallback(() => {
    void client.call<ProjectInfo>('project.info')
      .then(setProject)
      .catch((reason: unknown) => notify(`project.info: ${reasonText(reason)}`, 'bad'));
  }, [client, notify]);

  const open = useCallback((screen: ScreenId) => {
    setActive(screen);
    setVisited((current) => current.has(screen) ? current : new Set(current).add(screen));
  }, []);

  useEffect(() => {
    refreshDevices();
    refreshProject();
    void client.call<{ entries: LogEntry[] }>('logs.list', { limit: MAX_LIVE })
      .then((result) => setEntries(result.entries))
      .catch((reason: unknown) => notify(`logs.list: ${reasonText(reason)}`, 'bad'));

    const offs = [
      client.on<LogEntry>('log:entry', (entry) => {
        setEntries((current) => [...current.slice(-(MAX_LIVE - 1)), entry]);
      }),
      client.on<NetworkEntry>('network:request', (entry) => {
        setNetworkEntries((current) => [...current.slice(-(MAX_LIVE - 1)), redactEntry(entry)]);
      }),
      client.on<FpsSample>('perf:fps-sample', (sample) => {
        setFpsSamples((current) => [...current.slice(-(MAX_LIVE - 1)), sample]);
      }),
      client.on('device:list-updated', refreshDevices),
      client.on('device:booted', refreshDevices),
      client.on('device:shutdown', refreshDevices),
      client.on<ProcessExit>('process:exit', (event) => {
        if (event.id === 'metro') setMetro({ status: 'stopped' });
      }),
      client.on('metro:ready', () => setMetro({ status: 'running' })),
      client.on('metro:stopped', () => setMetro({ status: 'stopped' })),
    ];
    return () => {
      for (const off of offs) off();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [client, notify, refreshDevices, refreshProject]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const screen = SCREENS.find((item) => item.key === event.key);
      if (screen) open(screen.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const context: DashboardContextValue = {
    client, notify, devices, refreshDevices, deviceFilter, setDeviceFilter, project, refreshProject,
    entries, clearEntries: () => setEntries([]), networkEntries, fpsSamples, metro, setMetro, open,
  };

  const iosCount = devices.filter((device) => device.platform === 'ios').length;
  const androidCount = devices.filter((device) => device.platform === 'android').length;
  const bootedCount = devices.filter((device) => device.state === 'booted').length;
  const navEntry = (screen: (typeof SCREENS)[number]): ReactNode => {
    const isActive = active === screen.id;
    return (
      <button
        key={screen.id}
        type="button"
        onClick={() => open(screen.id)}
        className={`group flex w-full items-center gap-3 rounded px-3 py-2 text-left transition-colors ${isActive ? 'bg-raised text-inktext' : 'text-muted hover:bg-surface hover:text-inktext'}`}
      >
        <Icon name={screen.id} />
        <span className="flex-1 text-sm">{screen.label}</span>
        <span className={`font-mono text-[10px] ${isActive ? 'text-accent' : 'text-muted/50'}`}>[{screen.key}]</span>
      </button>
    );
  };

  return (
    <DashboardContext.Provider value={context}>
      <div className="flex h-screen flex-col overflow-hidden bg-ink text-inktext">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-5">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-xl font-semibold tracking-tight text-accent">◆ rnctl</span>
            <span className="hidden text-xs text-muted sm:inline">react native mission control</span>
          </div>
          <div className="flex items-center gap-4 font-mono text-xs text-muted">
            <span className="hidden max-w-[40vw] truncate md:inline">{project?.name ?? '…'}</span>
            <span className="flex items-center gap-1.5 text-good"><span className="h-1.5 w-1.5 rounded-full bg-good" />daemon</span>
          </div>
        </header>

        {project && !project.isReactNative && (
          <div role="alert" className="flex shrink-0 items-start gap-3 border-b border-warn/40 bg-warn/10 px-5 py-2.5 text-sm">
            <span className="font-mono font-semibold text-warn">!</span>
            <p className="text-warn">
              <strong className="font-semibold">Not a React Native project.</strong>{' '}
              rnctl works best inside an Expo or React Native project. Run/install actions use the scripts found in this project&apos;s package.json, and some device actions need an app installed.
            </p>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
            <div className="border-b border-line px-5 py-4">
              <div className="flex items-baseline gap-1.5">
                <span className="font-display text-2xl leading-none text-accent">◆</span>
                <span className="font-display text-2xl font-semibold tracking-tight text-inktext">rnctl</span>
              </div>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">mission control</p>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto p-2.5">
              {navEntry(SCREENS[0])}
              <div className="ml-6 space-y-0.5 border-l border-line pl-3">
                {(['all', 'ios', 'android'] as const).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => { setDeviceFilter(filter); open('devices'); }}
                    className={`flex w-full items-center justify-between rounded px-2 py-1 font-mono text-xs transition-colors ${active === 'devices' && deviceFilter === filter ? 'text-accent' : 'text-muted hover:text-inktext'}`}
                  >
                    <span>{filter === 'all' ? 'All devices' : filter === 'ios' ? 'iOS' : 'Android'}</span>
                    <span>{filter === 'all' ? devices.length : filter === 'ios' ? iosCount : androidCount}</span>
                  </button>
                ))}
              </div>
              {SCREENS.slice(1).map(navEntry)}
            </nav>
            <div className="space-y-1 border-t border-line px-4 py-3 font-mono text-[10px] text-muted">
              <p>{devices.length} devices · {bootedCount} booted</p>
              <p>metro {metro.status}</p>
            </div>
          </aside>

          <main className="relative min-w-0 flex-1 overflow-y-auto">
            {SCREENS.map((screen) => visited.has(screen.id) && (
              <div key={screen.id} hidden={active !== screen.id} className="h-full">
                {screen.id === 'devices' && <DevicesSection />}
                {screen.id === 'logs' && <LogsSection />}
                {screen.id === 'metro' && <MetroSection />}
                {screen.id === 'environment' && <EnvironmentSection />}
                {screen.id === 'broadcast' && <BroadcastSection />}
                {screen.id === 'storage' && <StorageSection />}
                {screen.id === 'perf' && <PerfSection />}
                {screen.id === 'tweaks' && <TweaksSection />}
                {screen.id === 'e2e' && <E2ESection />}
              </div>
            ))}
          </main>
        </div>

        <footer className="flex min-h-8 shrink-0 items-center gap-2 border-t border-line bg-surface px-5 py-1.5 font-mono text-xs">
          <span className="flex items-center gap-1.5 text-good"><span className="h-1.5 w-1.5 rounded-full bg-good" />live</span>
          <span className="text-line">│</span>
          <span className={TONE_CLASS[toast.tone]}>{toast.text}</span>
        </footer>
      </div>
    </DashboardContext.Provider>
  );
}
