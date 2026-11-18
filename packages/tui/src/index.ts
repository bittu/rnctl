/**
 * Fixed-viewport mission control: header + tab bar never scroll, only the active
 * screen's content does. Screens are stateless views over state owned here, so
 * switching tabs keeps the device list, selection, log buffer and health checks.
 *
 * Tabs: 1-4 or [/] or click · devices: ↑/↓ or click · r reload · d dev menu ·
 * s start · x stop · c clear logs · i environment · q/Ctrl+C quit.
 */
import {
  createCliRenderer,
  createTextAttributes,
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
} from '@opentui/core';
import { createElement, createRoot, useKeyboard, useRenderer, type Root } from '@opentui/react';
import { RpcClient } from '@rnctl/core';
import type { DeviceInfo, LogEntry, ProcessExit } from '@rnctl/sdk';
import { useEffect, useRef, useState, type ReactNode } from 'react';

type Tone = 'accent' | 'good' | 'warn' | 'bad' | 'muted' | 'text';
type TabId = 'devices' | 'logs' | 'metro' | 'environment';
type MetroStatus = 'unknown' | 'running' | 'stopped';
interface Notice { text: string; tone: Tone }
interface HealthCheck { name: string; ok: boolean; detail: string }

const MAX_LOGS = 200;
const TABS: ReadonlyArray<{ id: TabId; label: string; key: string }> = [
  { id: 'devices', label: 'DEVICES', key: '1' },
  { id: 'logs', label: 'LOGS', key: '2' },
  { id: 'metro', label: 'METRO', key: '3' },
  { id: 'environment', label: 'ENVIRONMENT', key: '4' },
];

const C = {
  accent: '#22d3ee',
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
  muted: '#7c8ba1',
  text: '#e2e8f0',
  root: '#080b11',
  panel: '#0f1622',
  selected: '#0e4a5a',
  border: '#243044',
} as const;

const BOLD = createTextAttributes({ bold: true });
const DIM = createTextAttributes({ dim: true });

function cut(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function t(content: string, opts: { fg?: string; bold?: boolean; dim?: boolean; truncate?: boolean; grow?: boolean } = {}): ReactNode {
  return createElement('text', {
    content,
    fg: opts.fg ?? C.text,
    attributes: opts.bold ? BOLD : opts.dim ? DIM : undefined,
    truncate: opts.truncate,
    flexGrow: opts.grow ? 1 : undefined,
    minWidth: opts.grow ? 0 : undefined,
  });
}

function panel(title: string, meta: string | undefined, tone: Tone, children: ReactNode): ReactNode {
  return createElement(
    'box',
    {
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: C[tone],
      backgroundColor: C.panel,
      paddingX: 1,
      gap: 1,
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      overflow: 'hidden',
    },
    createElement(
      'box',
      { flexDirection: 'row', justifyContent: 'space-between', flexShrink: 0, minHeight: 0 },
      t(title, { fg: C[tone], bold: true }),
      meta ? t(meta, { fg: C.muted, dim: true }) : null,
    ),
    children,
  );
}

function deviceRow(device: DeviceInfo, index: number, active: boolean, onSelect: (index: number) => void): ReactNode {
  const glyph = device.state === 'booted' ? '●' : '○';
  return createElement(
    'box',
    {
      key: `dev-${index}`,
      id: `dev-${index}`,
      flexDirection: 'row',
      gap: 1,
      height: 1,
      flexShrink: 0,
      paddingX: 1,
      backgroundColor: active ? C.selected : undefined,
      onMouseUp: () => onSelect(index),
    },
    t(String(index + 1).padStart(2, ' '), { fg: active ? C.accent : C.muted }),
    t(glyph, { fg: device.state === 'booted' ? C.good : C.muted }),
    t(cut(device.name, 48), { bold: active, grow: true, truncate: true }),
    t(device.platform === 'ios' ? 'iOS' : 'AND', { fg: active ? C.accent : C.muted }),
    t(device.state, { fg: device.state === 'booted' ? C.good : C.muted }),
  );
}

function DevicesScreen({ devices, selected, scrollRef, onSelect }: {
  devices: DeviceInfo[];
  selected: number;
  scrollRef: React.RefObject<ScrollBoxRenderable | null>;
  onSelect: (index: number) => void;
}): ReactNode {
  const booted = devices.filter((device) => device.state === 'booted').length;
  return panel(
    'DEVICES',
    `${devices.length} found · ${booted} booted`,
    'accent',
    createElement(
      'scrollbox',
      {
        ref: scrollRef,
        flexGrow: 1,
        flexBasis: 0,
        minHeight: 0,
        overflow: 'hidden',
        scrollY: true,
      },
      devices.length === 0
        ? t('No devices discovered. Boot a simulator or connect an emulator.', { fg: C.muted, dim: true })
        : devices.map((device, index) => deviceRow(device, index, index === selected, onSelect)),
    ),
  );
}

function logTone(level: LogEntry['level']): Tone {
  return level === 'error' ? 'bad' : level === 'warn' ? 'warn' : level === 'debug' ? 'muted' : 'accent';
}

function LogsScreen({ entries }: { entries: LogEntry[] }): ReactNode {
  return panel(
    'LIVE LOGS',
    `${entries.length} entries`,
    'warn',
    createElement(
      'scrollbox',
      {
        flexGrow: 1,
        flexBasis: 0,
        minHeight: 0,
        overflow: 'hidden',
        scrollY: true,
        stickyScroll: true,
        stickyStart: 'bottom',
        focused: true,
      },
      entries.length === 0
        ? t('No log entries yet. Start Metro to see activity here.', { fg: C.muted, dim: true })
        : entries.map((entry) => createElement(
          'box',
          { key: entry.id, flexDirection: 'row', gap: 1, height: 1, flexShrink: 0 },
          t(clock(entry.timestamp), { fg: C.muted, dim: true }),
          t(entry.level.slice(0, 5).toUpperCase(), { fg: C[logTone(entry.level)] }),
          t(entry.source, { fg: C.muted }),
          t(cut(entry.message, 120), { grow: true, truncate: true }),
        )),
    ),
  );
}

function action(label: string, tone: Tone, onPress: () => void): ReactNode {
  return createElement(
    'box',
    {
      key: label,
      height: 3,
      paddingX: 2,
      border: true,
      borderStyle: 'rounded',
      borderColor: C[tone],
      justifyContent: 'center',
      alignItems: 'center',
      onMouseUp: onPress,
    },
    t(label, { fg: C[tone], bold: true }),
  );
}

function MetroScreen({ metro, onStart, onStop, onReload, onMenu }: {
  metro: { status: MetroStatus; pid?: number };
  onStart: () => void;
  onStop: () => void;
  onReload: () => void;
  onMenu: () => void;
}): ReactNode {
  const tone: Tone = metro.status === 'running' ? 'good' : metro.status === 'stopped' ? 'bad' : 'warn';
  const glyph = metro.status === 'running' ? '●' : metro.status === 'stopped' ? '○' : '◐';
  return panel(
    'METRO',
    metro.status,
    'accent',
    createElement(
      'scrollbox',
      { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'hidden', scrollY: true, focused: true },
      createElement(
        'box',
        { flexDirection: 'column', gap: 1, flexShrink: 0 },
        createElement(
          'box',
          { flexDirection: 'row', gap: 1, flexShrink: 0 },
          t(glyph, { fg: C[tone], bold: true }),
          t(metro.status, { fg: C[tone], bold: true }),
          t(metro.pid === undefined ? '' : `pid ${metro.pid}`, { fg: C.muted, dim: true }),
        ),
        createElement(
          'box',
          { flexDirection: 'row', gap: 1, flexShrink: 0 },
          action('START', 'good', onStart),
          action('STOP', 'bad', onStop),
          action('RELOAD', 'accent', onReload),
          action('DEV MENU', 'warn', onMenu),
        ),
        t('Click an action, or use s / x / r / d.', { fg: C.muted, dim: true }),
      ),
    ),
  );
}

function EnvironmentScreen({ health }: { health: HealthCheck[] | undefined }): ReactNode {
  const ok = health?.filter((check) => check.ok).length ?? 0;
  return panel(
    'ENVIRONMENT',
    health ? `${ok}/${health.length} ok` : 'checking…',
    'good',
    createElement(
      'scrollbox',
      { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'hidden', scrollY: true, focused: true },
      health === undefined
        ? t('Checking environment…', { fg: C.muted, dim: true })
        : health.map((check) => createElement(
          'box',
          { key: check.name, flexDirection: 'row', gap: 1, height: 1, flexShrink: 0 },
          t(check.ok ? '✓' : '✗', { fg: check.ok ? C.good : C.bad }),
          t(cut(check.name, 16), { fg: check.ok ? C.text : C.bad }),
          t(cut(check.detail, 96), { fg: C.muted, grow: true, truncate: true }),
        )),
    ),
  );
}

function Dashboard({ client }: { client: RpcClient }) {
  const renderer = useRenderer();
  const mounted = useRef(true);
  const devicesScroll = useRef<ScrollBoxRenderable | null>(null);
  const healthRequested = useRef(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [metro, setMetro] = useState<{ status: MetroStatus; pid?: number }>({ status: 'unknown' });
  const [notice, setNotice] = useState<Notice>({ text: 'ready', tone: 'muted' });
  const [health, setHealth] = useState<HealthCheck[] | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<TabId>('devices');

  /** Fire an action and surface failures in the footer instead of crashing. */
  const invoke = (method: string, params: unknown, message: string, onDone?: () => void): void => {
    void client.call(method, params)
      .then(() => {
        if (!mounted.current) return;
        setNotice({ text: message, tone: 'good' });
        onDone?.();
      })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `${method}: ${reasonText(reason)}`, tone: 'bad' });
      });
  };

  useEffect(() => {
    let active = true;
    mounted.current = true;
    const fail = (method: string, reason: unknown): void => {
      if (active) setNotice({ text: `${method}: ${reasonText(reason)}`, tone: 'bad' });
    };

    const refreshDevices = (): void => {
      void client.call<{ devices: DeviceInfo[] }>('devices.list')
        .then((result) => { if (active) setDevices(result.devices); })
        .catch((reason: unknown) => fail('devices.list', reason));
    };
    refreshDevices();
    void client.call<{ entries: LogEntry[] }>('logs.list', { limit: 100 })
      .then((result) => { if (active) setEntries(result.entries); })
      .catch((reason: unknown) => fail('logs.list', reason));

    const offs = [
      client.on<LogEntry>('log:entry', (entry) => {
        if (active) setEntries((current) => [...current.slice(-(MAX_LOGS - 1)), entry]);
      }),
      client.on('device:list-updated', refreshDevices),
      client.on('device:booted', refreshDevices),
      client.on('device:shutdown', refreshDevices),
      client.on<ProcessExit>('process:exit', (event) => {
        if (active && event.id === 'metro') setMetro({ status: 'stopped' });
      }),
      client.on('metro:ready', () => { if (active) setMetro({ status: 'running' }); }),
      client.on('metro:stopped', () => { if (active) setMetro({ status: 'stopped' }); }),
    ];
    return () => {
      active = false;
      mounted.current = false;
      for (const off of offs) off();
    };
  }, [client]);

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, devices.length - 1)));
  }, [devices.length]);

  useEffect(() => {
    if (activeTab === 'devices' && devices[selected]) {
      devicesScroll.current?.scrollChildIntoView(`dev-${selected}`, { align: 'nearest' });
    }
  }, [activeTab, selected, devices.length]);

  useEffect(() => {
    if (activeTab !== 'environment' || healthRequested.current) return;
    healthRequested.current = true;
    void client.call<{ checks: HealthCheck[] }>('doctor.check')
      .then((result) => { if (mounted.current) setHealth(result.checks); })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `doctor.check: ${reasonText(reason)}`, tone: 'bad' });
      });
  }, [activeTab, client]);

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl || key.meta || key.eventType === 'release') return;
    const name = key.name;
    if (name === 'q') { renderer.destroy(); return; }
    if (name === 'tab' || name === '[' || name === ']') {
      key.preventDefault();
      setActiveTab((current) => {
        const index = TABS.findIndex((tab) => tab.id === current);
        const step = name === '[' ? -1 : 1;
        return TABS[(index + step + TABS.length) % TABS.length]!.id;
      });
      return;
    }
    if (/^[1-4]$/.test(name)) {
      key.preventDefault();
      setActiveTab(TABS[Number(name) - 1]!.id);
      return;
    }
    if (name === 'up' || name === 'down') {
      if (activeTab === 'devices') {
        key.preventDefault();
        setSelected((current) => Math.max(0, Math.min(devices.length - 1, current + (name === 'up' ? -1 : 1))));
      }
      return; // other screens keep focus so their scrollbox handles arrows
    }
    if (name === 'i') { setActiveTab('environment'); return; }
    const device = devices[selected];
    const target = device ? device.name : 'no device selected';
    switch (name) {
      case 'r': invoke('metro.reload', {}, `JS reload → ${target}`); break;
      case 'd': invoke('metro.devMenu', {}, `Dev menu → ${target}`); break;
      case 's': invoke('metro.start', { resetCache: false }, 'Metro start requested', () => setMetro({ status: 'running' })); break;
      case 'x': invoke('metro.stop', {}, 'Metro stop requested', () => setMetro({ status: 'stopped' })); break;
      case 'c': invoke('logs.clear', {}, 'Logs cleared', () => setEntries([])); break;
      default: break;
    }
  });

  const selectTab = (id: TabId): void => setActiveTab(id);
  const selectDevice = (index: number): void => {
    setSelected(index);
    setNotice({ text: `Selected ${devices[index]?.name ?? ''}`, tone: 'accent' });
  };

  let screen: ReactNode;
  switch (activeTab) {
    case 'logs':
      screen = createElement(LogsScreen, { entries });
      break;
    case 'metro':
      screen = createElement(MetroScreen, {
        metro,
        onStart: () => invoke('metro.start', { resetCache: false }, 'Metro start requested', () => setMetro({ status: 'running' })),
        onStop: () => invoke('metro.stop', {}, 'Metro stop requested', () => setMetro({ status: 'stopped' })),
        onReload: () => invoke('metro.reload', {}, `JS reload → ${devices[selected]?.name ?? 'no device selected'}`),
        onMenu: () => invoke('metro.devMenu', {}, `Dev menu → ${devices[selected]?.name ?? 'no device selected'}`),
      });
      break;
    case 'environment':
      screen = createElement(EnvironmentScreen, { health });
      break;
    default:
      screen = createElement(DevicesScreen, { devices, selected, scrollRef: devicesScroll, onSelect: selectDevice });
  }

  return createElement(
    'box',
    {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      backgroundColor: C.root,
      paddingX: 1,
      paddingTop: 1,
      paddingBottom: 1,
      gap: 1,
      overflow: 'hidden',
    },
    createElement(
      'box',
      {
        flexShrink: 0,
        height: 3,
        border: true,
        borderStyle: 'rounded',
        borderColor: C.accent,
        backgroundColor: C.panel,
        paddingX: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      },
      createElement(
        'box',
        { flexDirection: 'row', gap: 1 },
        t('◆ rnctl', { fg: C.accent, bold: true }),
        t('// MISSION CONTROL', { fg: C.muted, dim: true }),
      ),
      createElement(
        'box',
        { flexDirection: 'row', gap: 1 },
        t('● daemon', { fg: C.good }),
        t('v0.1.0', { fg: C.muted, dim: true }),
      ),
    ),
    createElement(
      'box',
      { flexShrink: 0, height: 3, flexDirection: 'row', gap: 1, paddingX: 1, alignItems: 'center' },
      ...TABS.map((tab) => createElement(
        'box',
        {
          key: tab.id,
          height: 3,
          paddingX: 2,
          border: true,
          borderStyle: 'rounded',
          borderColor: activeTab === tab.id ? C.accent : C.border,
          backgroundColor: activeTab === tab.id ? C.selected : C.panel,
          justifyContent: 'center',
          alignItems: 'center',
          onMouseUp: () => selectTab(tab.id),
        },
        t(`${tab.key} ${tab.label}`, { fg: activeTab === tab.id ? C.text : C.muted, bold: activeTab === tab.id }),
      )),
      t('  click a tab or press [/]', { fg: C.muted, dim: true, grow: true }),
    ),
    createElement('box', { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'hidden' }, screen),
    createElement(
      'box',
      {
        flexShrink: 0,
        height: 4,
        border: true,
        borderStyle: 'rounded',
        borderColor: C.border,
        backgroundColor: C.panel,
        paddingX: 1,
        flexDirection: 'column',
        justifyContent: 'center',
      },
      t(`${notice.tone === 'bad' ? '✗' : '›'} ${notice.text}`, { fg: C[notice.tone], truncate: true }),
      t('1-4 tabs · ↑↓ select/scroll · r reload · d menu · s/x metro · c clear · i env · q quit', {
        fg: C.muted,
        dim: true,
        truncate: true,
      }),
    ),
  );
}

export async function renderDashboard(client?: RpcClient): Promise<void> {
  // A dashboard needs raw-mode input; a piped stdin (CI, scripts) just gets a message.
  if (process.stdin.isTTY !== true) {
    process.stderr.write('rnctl dashboard requires an interactive terminal.\n');
    return;
  }

  let rpc: RpcClient | undefined = client;
  let renderer: CliRenderer | undefined;
  let root: Root | undefined;
  try {
    if (!rpc) rpc = await RpcClient.connect();

    let done!: () => void;
    const closed = new Promise<void>((resolve) => { done = resolve; });
    renderer = await createCliRenderer({ exitOnCtrlC: true, onDestroy: () => done() });
    root = createRoot(renderer);
    root.render(createElement(Dashboard, { client: rpc }));
    await closed;
  } catch (error) {
    process.stderr.write(`rnctl dashboard could not start: ${reasonText(error)}\n`);
  } finally {
    try { root?.unmount(); } catch { /* renderer may already be gone */ }
    try { renderer?.destroy(); } catch { /* already destroyed */ }
    rpc?.close();
  }
}
