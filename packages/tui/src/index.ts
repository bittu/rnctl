/**
 * Fixed-viewport mission control: header, side menu and footer never scroll; only
 * the active screen's content does. All state lives in Dashboard, so switching
 * screens keeps the device list, selection, log buffer, Metro status and health.
 *
 * Screens: 1-4 or [/] or ←/→ or click · devices: ↑/↓ or click · r reload · d dev
 * menu · s start · x stop · c clear logs · i environment · q/Ctrl+C quit.
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
type ScreenId = 'devices' | 'logs' | 'metro' | 'environment';
type DeviceFilter = 'all' | 'ios' | 'android';
type Platform = 'ios' | 'android';
type MetroStatus = 'unknown' | 'running' | 'stopped';
interface Notice { text: string; tone: Tone }
interface HealthCheck { name: string; ok: boolean; detail: string }
interface ProjectInfo {
  name: string;
  isReactNative: boolean;
  scripts: Array<{ name: string; command: string }>;
}
interface DeviceGroup { platform: Platform; devices: DeviceInfo[] }

const MAX_LOGS = 200;
const SCREENS: ReadonlyArray<{ id: ScreenId; label: string; key: string }> = [
  { id: 'devices', label: 'Devices', key: '1' },
  { id: 'logs', label: 'Logs', key: '2' },
  { id: 'metro', label: 'Metro', key: '3' },
  { id: 'environment', label: 'Environment', key: '4' },
];

/** Flat, neutral near-black palette: every surface is a shade of grey, not blue. */
const C = {
  accent: '#22d3ee',
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
  muted: '#71717a',
  text: '#e4e4e7',
  root: '#09090b',
  surface: '#111113',
  content: '#0d0d0f',
  selected: '#1c1c20',
  separator: '#1f1f23',
  warnBg: '#1a1508',
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

function t(content: string, opts: {
  fg?: string;
  bold?: boolean;
  dim?: boolean;
  truncate?: boolean;
  grow?: boolean;
  width?: number | `${number}%`;
  shrink?: boolean;
} = {}): ReactNode {
  return createElement('text', {
    content,
    height: 1,
    fg: opts.fg ?? C.text,
    attributes: opts.bold ? BOLD : opts.dim ? DIM : undefined,
    truncate: opts.truncate,
    width: opts.width,
    flexGrow: opts.grow ? 1 : undefined,
    flexShrink: opts.shrink ? 0 : undefined,
    minWidth: opts.grow ? 0 : undefined,
  });
}

function panel(title: string, meta: string | undefined, children: ReactNode): ReactNode {
  return createElement(
    'box',
    {
      flexDirection: 'column',
      backgroundColor: C.content,
      paddingX: 2,
      paddingY: 1,
      gap: 1,
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      overflow: 'hidden',
    },
    createElement(
      'box',
      { flexDirection: 'row', justifyContent: 'space-between', flexShrink: 0, minHeight: 0 },
      t(title, { bold: true }),
      meta ? t(meta, { fg: C.muted, dim: true }) : null,
    ),
    children,
  );
}

/** Booted devices first; iOS and Android stay as separate groups. */
function deviceGroups(devices: DeviceInfo[]): DeviceGroup[] {
  return (['ios', 'android'] as const)
    .map((platform) => ({
      platform,
      devices: devices
        .filter((device) => device.platform === platform)
        .sort((a, b) => Number(b.state === 'booted') - Number(a.state === 'booted') || a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.devices.length > 0)
    .sort((a, b) => {
      const bootedA = a.devices.filter((device) => device.state === 'booted').length;
      const bootedB = b.devices.filter((device) => device.state === 'booted').length;
      return bootedB - bootedA || (a.platform === 'ios' ? -1 : 1);
    });
}

function deviceRow(device: DeviceInfo, active: boolean, nameWidth: number, onSelect: (id: string) => void): ReactNode {
  const booted = device.state === 'booted';
  return createElement(
    'box',
    {
      key: `dev-${device.id}`,
      id: `dev-${device.id}`,
      flexDirection: 'row',
      gap: 1,
      height: 1,
      flexShrink: 0,
      paddingX: 1,
      backgroundColor: active ? C.selected : undefined,
      onMouseUp: () => onSelect(device.id),
    },
    t(active ? '▸' : ' ', { fg: active ? C.accent : C.muted, shrink: true }),
    t(booted ? '●' : '○', { fg: booted ? C.good : C.muted, shrink: true }),
    t(cut(device.name, nameWidth), { bold: active }),
    t(device.platform === 'ios' ? 'iOS' : 'AND', { fg: active ? C.accent : C.muted, shrink: true }),
  );
}

function disabledAction(label: string, hint: string): ReactNode {
  return createElement(
    'box',
    { key: label, height: 1, flexDirection: 'row', gap: 1, paddingX: 1, flexShrink: 0 },
    t('⊘', { fg: C.muted }),
    t(label, { fg: C.muted }),
    t(hint, { fg: C.muted, dim: true, grow: true, truncate: true }),
  );
}

function wiredAction(label: string, tone: Tone, onPress: () => void, grow = false): ReactNode {
  return createElement(
    'box',
    {
      key: label,
      height: 1,
      flexDirection: 'row',
      gap: 1,
      paddingX: 1,
      flexShrink: 0,
      flexGrow: grow ? 1 : undefined,
      backgroundColor: C.selected,
      onMouseUp: onPress,
    },
    t('›', { fg: C[tone] }),
    t(label, { fg: C[tone], bold: true, truncate: true }),
  );
}

function DeviceActions({ device, onReload, onMenu, onStart, onStop }: {
  device: DeviceInfo | undefined;
  onReload: () => void;
  onMenu: () => void;
  onStart: () => void;
  onStop: () => void;
}): ReactNode {
  if (!device) {
    return createElement(
      'box',
      { width: 28, flexShrink: 0, backgroundColor: C.surface, paddingX: 1, paddingY: 1, overflow: 'hidden' },
      t('Actions', { bold: true }),
      t('Select a device to see actions.', { fg: C.muted, dim: true }),
    );
  }
  const booted = device.state === 'booted';
  return createElement(
    'box',
    {
      width: 28,
      flexShrink: 0,
      backgroundColor: C.surface,
      paddingX: 1,
      paddingY: 1,
      flexDirection: 'column',
      overflow: 'hidden',
    },
    t('Actions', { bold: true }),
    t(cut(device.name, 26), { fg: C.muted }),
    // shortcut: boot/shutdown/install/run have no RPC yet; wire them here when plugin-devices adds them.
    disabledAction(booted ? 'Shutdown' : 'Boot', 'pending'),
    disabledAction('Install', 'pending'),
    disabledAction('Run app', 'pending'),
    wiredAction('JS reload', 'accent', onReload),
    wiredAction('Dev menu', 'warn', onMenu),
    wiredAction('Metro start', 'good', onStart),
    wiredAction('Stop', 'bad', onStop),
  );
}

function DevicesScreen({ groups, selectedId, nameWidth, scrollRef, onSelect, actions }: {
  groups: DeviceGroup[];
  selectedId: string | null;
  nameWidth: number;
  scrollRef: React.RefObject<ScrollBoxRenderable | null>;
  onSelect: (id: string) => void;
  actions: ReactNode;
}): ReactNode {
  const total = groups.reduce((sum, group) => sum + group.devices.length, 0);
  const booted = groups.reduce((sum, group) => sum + group.devices.filter((device) => device.state === 'booted').length, 0);
  return panel(
    'Devices',
    `${total} shown · ${booted} booted`,
    createElement(
      'box',
      { flexDirection: 'row', flexGrow: 1, flexBasis: 0, minHeight: 0, gap: 1, overflow: 'hidden' },
      createElement(
        'scrollbox',
        { ref: scrollRef, flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'hidden', scrollY: true, scrollbarOptions: { visible: false, showArrows: false } },
        groups.map((group) => createElement(
          'box',
          { key: group.platform, flexDirection: 'column', flexShrink: 0 },
          t(group.platform === 'ios' ? `iOS · ${group.devices.length}` : `ANDROID · ${group.devices.length}`, { fg: C.muted, dim: true }),
          group.devices.map((device) => deviceRow(device, device.id === selectedId, nameWidth, onSelect)),
        )),
        total === 0 ? t('No devices match this view.', { fg: C.muted, dim: true }) : null,
      ),
      actions,
    ),
  );
}

function logTone(level: LogEntry['level']): Tone {
  return level === 'error' ? 'bad' : level === 'warn' ? 'warn' : level === 'debug' ? 'muted' : 'accent';
}

function LogsScreen({ entries }: { entries: LogEntry[] }): ReactNode {
  return panel(
    'Live logs',
    `${entries.length} entries`,
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
        scrollbarOptions: { visible: false, showArrows: false },
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

function metroAction(label: string, tone: Tone, onPress: () => void): ReactNode {
  return createElement(
    'box',
    { key: label, height: 1, paddingX: 1, flexShrink: 0, backgroundColor: C.selected, onMouseUp: onPress },
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
    'Metro',
    metro.status,
    createElement(
      'scrollbox',
      { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'hidden', scrollY: true, focused: true, scrollbarOptions: { visible: false, showArrows: false } },
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
          metroAction('Start', 'good', onStart),
          metroAction('Stop', 'bad', onStop),
          metroAction('Reload', 'accent', onReload),
          metroAction('Dev menu', 'warn', onMenu),
        ),
        t('Click an action, or use s / x / r / d.', { fg: C.muted, dim: true }),
      ),
    ),
  );
}

function EnvironmentScreen({ health }: { health: HealthCheck[] | undefined }): ReactNode {
  const ok = health?.filter((check) => check.ok).length ?? 0;
  return panel(
    'Environment',
    health ? `${ok}/${health.length} ok` : 'checking…',
    createElement(
      'scrollbox',
      { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'hidden', scrollY: true, focused: true, scrollbarOptions: { visible: false, showArrows: false } },
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

function SideMenu({ active, filter, counts, onScreen, onFilter }: {
  active: ScreenId;
  filter: DeviceFilter;
  counts: Record<Platform, number>;
  onScreen: (id: ScreenId) => void;
  onFilter: (filter: DeviceFilter) => void;
}): ReactNode {
  const entry = (screen: ScreenId, label: string, key: string): ReactNode => {
    const isActive = active === screen;
    return createElement(
      'box',
      {
        key: screen,
        height: 1,
        flexDirection: 'row',
        gap: 1,
        paddingLeft: 1,
        flexShrink: 0,
        backgroundColor: isActive ? C.selected : undefined,
        onMouseUp: () => onScreen(screen),
      },
      t(isActive ? '▸' : ' ', { fg: isActive ? C.accent : C.muted }),
      t(key, { fg: isActive ? C.accent : C.muted }),
      t(label, { fg: isActive ? C.text : C.muted, bold: isActive, truncate: true }),
    );
  };
  const subEntry = (platform: Platform, label: string): ReactNode => {
    const isActive = active === 'devices' && filter === platform;
    return createElement(
      'box',
      {
        key: platform,
        height: 1,
        flexDirection: 'row',
        gap: 1,
        paddingLeft: 4,
        flexShrink: 0,
        backgroundColor: isActive ? C.selected : undefined,
        onMouseUp: () => { onFilter(platform); onScreen('devices'); },
      },
      t(isActive ? '›' : '·', { fg: isActive ? C.accent : C.muted }),
      t(`${label} ${counts[platform]}`, { fg: isActive ? C.accent : C.muted, truncate: true }),
    );
  };
  return createElement(
    'box',
    {
      width: 18,
      flexShrink: 0,
      paddingY: 1,
      flexDirection: 'column',
      overflow: 'hidden',
    },
    entry('devices', 'Devices', '1'),
    subEntry('ios', 'iOS'),
    subEntry('android', 'Android'),
    entry('logs', 'Logs', '2'),
    entry('metro', 'Metro', '3'),
    entry('environment', 'Environment', '4'),
  );
}

function Header({ project }: { project: ProjectInfo | undefined }): ReactNode {
  return createElement(
    'box',
    {
      flexShrink: 0,
      height: 3,
      backgroundColor: C.surface,
      paddingX: 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    createElement(
      'box',
      { flexDirection: 'column', flexShrink: 0 },
      t('◆ rnctl', { fg: C.accent, bold: true }),
      t('react native mission control', { fg: C.muted }),
    ),
    createElement(
      'box',
      { flexDirection: 'row', gap: 2, flexShrink: 0 },
      t(project?.name ?? '…', { fg: C.muted, dim: true, truncate: true }),
      t('● daemon', { fg: C.good }),
    ),
  );
}

function Dashboard({ client }: { client: RpcClient }) {
  const renderer = useRenderer();
  const mounted = useRef(true);
  const devicesScroll = useRef<ScrollBoxRenderable | null>(null);
  const healthRequested = useRef(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<DeviceFilter>('all');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [metro, setMetro] = useState<{ status: MetroStatus; pid?: number }>({ status: 'unknown' });
  const [notice, setNotice] = useState<Notice>({ text: 'ready', tone: 'muted' });
  const [health, setHealth] = useState<HealthCheck[] | undefined>(undefined);
  const [project, setProject] = useState<ProjectInfo | undefined>(undefined);
  const [active, setActive] = useState<ScreenId>('devices');

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
    let live = true;
    mounted.current = true;
    const fail = (method: string, reason: unknown): void => {
      if (live) setNotice({ text: `${method}: ${reasonText(reason)}`, tone: 'bad' });
    };

    const refreshDevices = (): void => {
      void client.call<{ devices: DeviceInfo[] }>('devices.list')
        .then((result) => { if (live) setDevices(result.devices); })
        .catch((reason: unknown) => fail('devices.list', reason));
    };
    refreshDevices();
    void client.call<{ entries: LogEntry[] }>('logs.list', { limit: 100 })
      .then((result) => { if (live) setEntries(result.entries); })
      .catch((reason: unknown) => fail('logs.list', reason));
    // Project detection lives in @rnctl/plugin-doctor; the TUI only displays the result.
    void client.call<ProjectInfo>('project.info', { cwd: process.cwd() })
      .then((result) => { if (live) setProject(result); })
      .catch((reason: unknown) => fail('project.info', reason));

    const offs = [
      client.on<LogEntry>('log:entry', (entry) => {
        if (live) setEntries((current) => [...current.slice(-(MAX_LOGS - 1)), entry]);
      }),
      client.on('device:list-updated', refreshDevices),
      client.on('device:booted', refreshDevices),
      client.on('device:shutdown', refreshDevices),
      client.on<ProcessExit>('process:exit', (event) => {
        if (live && event.id === 'metro') setMetro({ status: 'stopped' });
      }),
      client.on('metro:ready', () => { if (live) setMetro({ status: 'running' }); }),
      client.on('metro:stopped', () => { if (live) setMetro({ status: 'stopped' }); }),
    ];
    return () => {
      live = false;
      mounted.current = false;
      for (const off of offs) off();
    };
  }, [client]);

  const groups = deviceGroups(devices.filter((device) => filter === 'all' || device.platform === filter));
  const ordered = groups.flatMap((group) => group.devices);
  const selectedDevice = devices.find((device) => device.id === selectedId) ?? ordered[0];

  useEffect(() => {
    if (ordered.length === 0) { if (selectedId !== null) setSelectedId(null); return; }
    if (!ordered.some((device) => device.id === selectedId)) setSelectedId(ordered[0]!.id);
  }, [ordered, selectedId]);

  useEffect(() => {
    if (active === 'devices' && selectedDevice) {
      devicesScroll.current?.scrollChildIntoView(`dev-${selectedDevice.id}`, { align: 'nearest' });
    }
  }, [active, selectedDevice, filter]);

  useEffect(() => {
    if (active !== 'environment' || healthRequested.current) return;
    healthRequested.current = true;
    void client.call<{ checks: HealthCheck[] }>('doctor.check')
      .then((result) => { if (mounted.current) setHealth(result.checks); })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `doctor.check: ${reasonText(reason)}`, tone: 'bad' });
      });
  }, [active, client]);

  const cycle = (step: number): void => {
    setActive((current) => {
      const index = SCREENS.findIndex((screen) => screen.id === current);
      return SCREENS[(index + step + SCREENS.length) % SCREENS.length]!.id;
    });
  };

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl || key.meta || key.eventType === 'release') return;
    const name = key.name;
    if (name === 'q') { renderer.destroy(); return; }
    if (name === 'tab' || name === '[' || name === 'left' || name === 'right') {
      key.preventDefault();
      cycle(name === '[' || name === 'left' ? -1 : 1);
      return;
    }
    if (/^[1-4]$/.test(name)) {
      key.preventDefault();
      setActive(SCREENS[Number(name) - 1]!.id);
      return;
    }
    if (name === 'up' || name === 'down') {
      if (active === 'devices' && ordered.length > 0) {
        key.preventDefault();
        const index = ordered.findIndex((device) => device.id === selectedDevice?.id);
        const next = Math.max(0, Math.min(ordered.length - 1, (index < 0 ? 0 : index) + (name === 'up' ? -1 : 1)));
        setSelectedId(ordered[next]!.id);
      }
      return; // other screens keep focus so their scrollbox handles arrows
    }
    if (name === 'i') { setActive('environment'); return; }
    const target = selectedDevice ? selectedDevice.name : 'no device selected';
    switch (name) {
      case 'r': invoke('metro.reload', {}, `JS reload → ${target}`); break;
      case 'd': invoke('metro.devMenu', {}, `Dev menu → ${target}`); break;
      case 's': invoke('metro.start', { resetCache: false }, 'Metro start requested', () => setMetro({ status: 'running' })); break;
      case 'x': invoke('metro.stop', {}, 'Metro stop requested', () => setMetro({ status: 'stopped' })); break;
      case 'c': invoke('logs.clear', {}, 'Logs cleared', () => setEntries([])); break;
      default: break;
    }
  });

  const target = selectedDevice?.name ?? 'no device selected';
  let screen: ReactNode;
  switch (active) {
    case 'logs':
      screen = createElement(LogsScreen, { entries });
      break;
    case 'metro':
      screen = createElement(MetroScreen, {
        metro,
        onStart: () => invoke('metro.start', { resetCache: false }, 'Metro start requested', () => setMetro({ status: 'running' })),
        onStop: () => invoke('metro.stop', {}, 'Metro stop requested', () => setMetro({ status: 'stopped' })),
        onReload: () => invoke('metro.reload', {}, `JS reload → ${target}`),
        onMenu: () => invoke('metro.devMenu', {}, `Dev menu → ${target}`),
      });
      break;
    case 'environment':
      screen = createElement(EnvironmentScreen, { health });
      break;
    default:
      // sidebar 18 + separator 1 + content/panel padding 5 + actions 28 + gap 1 + row chrome 12
      const nameWidth = Math.max(12, Math.min(48, (renderer.width || 80) - 65));
      screen = createElement(DevicesScreen, {
        groups,
        selectedId: selectedDevice?.id ?? null,
        nameWidth,
        scrollRef: devicesScroll,
        onSelect: (id: string) => {
          setSelectedId(id);
          setNotice({ text: `Selected ${devices.find((device) => device.id === id)?.name ?? ''}`, tone: 'accent' });
        },
        actions: createElement(DeviceActions, {
          device: selectedDevice,
          onReload: () => invoke('metro.reload', {}, `JS reload → ${target}`),
          onMenu: () => invoke('metro.devMenu', {}, `Dev menu → ${target}`),
          onStart: () => invoke('metro.start', { resetCache: false }, 'Metro start requested', () => setMetro({ status: 'running' })),
          onStop: () => invoke('metro.stop', {}, 'Metro stop requested', () => setMetro({ status: 'stopped' })),
        }),
      });
  }

  const counts: Record<Platform, number> = {
    ios: devices.filter((device) => device.platform === 'ios').length,
    android: devices.filter((device) => device.platform === 'android').length,
  };

  return createElement(
    'box',
    {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      backgroundColor: C.root,
      paddingX: 1,
      paddingTop: 1,
      gap: 1,
      overflow: 'hidden',
    },
    createElement(Header, { project }),
    project && !project.isReactNative
      ? createElement(
        'box',
        { flexShrink: 0, height: 1, backgroundColor: C.warnBg, paddingX: 2, flexDirection: 'row', alignItems: 'center', gap: 1 },
        t('⚠', { fg: C.warn, bold: true }),
        t('Not a React Native / Expo project — rnctl works best in an RN project.', { fg: C.warn, truncate: true }),
      )
      : null,
    createElement(
      'box',
      { flexGrow: 1, flexBasis: 0, minHeight: 0, flexDirection: 'row', overflow: 'hidden' },
      createElement(SideMenu, {
        active,
        filter,
        counts,
        onScreen: setActive,
        onFilter: setFilter,
      }),
      createElement('box', { width: 1, flexShrink: 0, backgroundColor: C.separator }),
      createElement('box', { flexGrow: 1, flexBasis: 0, minHeight: 0, backgroundColor: C.content, paddingLeft: 1, overflow: 'hidden' }, screen),
    ),
    createElement(
      'box',
      {
        flexShrink: 0,
        height: 2,
        backgroundColor: C.surface,
        paddingX: 2,
        flexDirection: 'column',
        justifyContent: 'center',
      },
      t(`${notice.tone === 'bad' ? '✗' : '›'} ${notice.text}`, { fg: C[notice.tone], truncate: true }),
      t('1-4 / [ ] / ←→ screens · ↑↓ devices · r reload · d menu · s/x metro · c clear · i env · q quit', {
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
    // Paint the whole canvas near-black; the root box alone can leave gaps in its layout area.
    renderer = await createCliRenderer({ exitOnCtrlC: true, backgroundColor: C.root, onDestroy: () => done() });
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
