/**
 * Fixed-viewport mission control: header, side menu and footer never scroll; only
 * the active screen's content does. All state lives in Dashboard, so switching
 * screens keeps the device list, selection, log buffer, Metro status and health.
 *
 * Screens: 1-4 or [/] or ←/→ or click · devices: ↑/↓ or click · r reload · d dev
 * menu · s start · x stop · c clear logs · i environment · b boot · p shutdown ·
 * f install app · a run app · broadcast: r/d/t · q/Ctrl+C quit.
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
type ScreenId = 'devices' | 'logs' | 'metro' | 'environment' | 'broadcast';
type DeviceFilter = 'all' | 'ios' | 'android';
type Platform = 'ios' | 'android';
type MetroStatus = 'unknown' | 'running' | 'stopped';
type PromptKind = 'installApp' | 'runApp' | 'deepLink';
interface Notice { text: string; tone: Tone }
interface ActionResult { ok: boolean; message: string }
interface BroadcastItem { id: string; platform: string; ok: boolean; message: string }
interface BroadcastResult { results: BroadcastItem[]; sent: number }
interface BroadcastSummary { label: string; sent: number; results: BroadcastItem[] }
interface HealthCheck { name: string; ok: boolean; detail: string }
interface ProjectInfo {
  name: string;
  isReactNative: boolean;
  scripts: Array<{ name: string; command: string }>;
}
interface DeviceGroup { platform: Platform; devices: DeviceInfo[] }
type LogSourceId = 'metro' | 'console' | 'android' | 'ios' | 'network';
interface LogSource { id: LogSourceId; label: string; available: boolean; reason?: string }
interface LogSession {
  sessionId: string;
  source: LogSourceId;
  label: string;
  entries: LogEntry[];
}
interface AttachResult { sessionId: string; started: boolean; message: string }

const MAX_LOGS = 200;
const SCREENS: ReadonlyArray<{ id: ScreenId; label: string; key: string }> = [
  { id: 'devices', label: 'Devices', key: '1' },
  { id: 'logs', label: 'Logs', key: '2' },
  { id: 'metro', label: 'Metro', key: '3' },
  { id: 'environment', label: 'Environment', key: '4' },
  { id: 'broadcast', label: 'Broadcast', key: '5' },
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
    t(cut(device.name, nameWidth), { bold: active }),
    t(device.platform === 'ios' ? 'iOS' : 'AND', { fg: active ? C.accent : C.muted, shrink: true }),
    t(booted ? '· running' : '· shutdown', { fg: booted ? C.good : C.muted, shrink: true }),
  );
}

function wiredAction(label: string, tone: Tone, onPress: () => void): ReactNode {
  return createElement(
    'box',
    {
      key: label,
      height: 1,
      flexDirection: 'row',
      gap: 1,
      paddingX: 1,
      flexShrink: 0,
      backgroundColor: C.selected,
      onMouseUp: onPress,
    },
    t('›', { fg: C[tone] }),
    t(label, { fg: C[tone], bold: true, truncate: true }),
  );
}

function DeviceActions({ device, width, prompt, promptValue, onBoot, onShutdown, onInstall, onRunApp, onReload, onMenu, onStart, onStop }: {
  device: DeviceInfo | undefined;
  width: number;
  prompt: PromptKind | null;
  promptValue: string;
  onBoot: () => void;
  onShutdown: () => void;
  onInstall: () => void;
  onRunApp: () => void;
  onReload: () => void;
  onMenu: () => void;
  onStart: () => void;
  onStop: () => void;
}): ReactNode {
  if (!device) {
    return createElement(
      'box',
      { width, flexShrink: 0, backgroundColor: C.surface, paddingX: 1, paddingY: 1, overflow: 'hidden' },
      t('Actions', { bold: true }),
      t('Select a device to see actions.', { fg: C.muted, dim: true }),
    );
  }
  const booted = device.state === 'booted';
  // No file picker in the TUI: install takes a typed path, run takes a typed bundle/package id.
  return createElement(
    'box',
    {
      width,
      flexShrink: 0,
      backgroundColor: C.surface,
      paddingX: 1,
      paddingY: 1,
      flexDirection: 'column',
      overflow: 'hidden',
    },
    t('Actions', { bold: true }),
    t(cut(device.name, width - 2), { fg: C.muted }),
    prompt === null ? createElement(
      'box',
      { key: 'device-actions', flexDirection: 'column', flexShrink: 0 },
      wiredAction(booted ? 'p Shutdown' : 'b Boot', booted ? 'warn' : 'good', booted ? onShutdown : onBoot),
      wiredAction('f Install app', 'accent', onInstall),
      wiredAction('a Run app', 'accent', onRunApp),
      wiredAction('r JS reload', 'accent', onReload),
      wiredAction('d Dev menu', 'warn', onMenu),
      wiredAction('s Metro start', 'good', onStart),
      wiredAction('x Stop', 'bad', onStop),
    ) : createElement(
      'box',
      { key: 'prompt', flexDirection: 'column', flexShrink: 0 },
      t(prompt === 'installApp' ? 'Install path' : prompt === 'deepLink' ? 'Deep link URL' : 'Bundle / package', { fg: C.muted }),
      t(`${cut(promptValue, width - 3)}▌`, { fg: C.text }),
      t('↵ ok · esc cancel', { fg: C.muted, dim: true }),
    ),
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

function LogsScreen({ entries, sources, sessions, activeSessionId, selectedSourceIndex, compact, onSelectTab, onCloseTab, onAttachSource, onSelectSource }: {
  entries: LogEntry[];
  sources: LogSource[];
  sessions: LogSession[];
  activeSessionId: string | null;
  selectedSourceIndex: number;
  compact: boolean;
  onSelectTab: (sessionId: string | null) => void;
  onCloseTab: (sessionId: string) => void;
  onAttachSource: (source: LogSource) => void;
  onSelectSource: (index: number) => void;
}): ReactNode {
  const visible = activeSessionId === null ? entries : sessions.find((session) => session.sessionId === activeSessionId)?.entries ?? [];
  const chip = (key: string, label: string, active: boolean, tone: Tone, onPress: () => void): ReactNode => createElement(
    'box',
    {
      key,
      height: 1,
      flexDirection: 'row',
      gap: 1,
      paddingX: 1,
      flexShrink: 0,
      backgroundColor: active ? C.selected : undefined,
      onMouseUp: onPress,
    },
    t(label, { fg: active ? C.text : C[tone], bold: active, truncate: true }),
  );
  const shortLabel = (source: LogSource): string => {
    if (source.id === 'console') return 'JS';
    if (compact) return source.id === 'android' ? 'And' : source.id === 'network' ? 'Net' : source.label;
    return source.id === 'android' ? 'Android' : source.label;
  };
  return panel(
    'Live logs',
    `${visible.length} entries · ${sessions.length} tabs`,
    createElement(
      'box',
      { flexDirection: 'column', flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'hidden' },
      createElement(
        'box',
        { flexDirection: 'row', gap: 1, flexShrink: 0 },
        chip('all', activeSessionId === null ? '▸ All' : 'All', activeSessionId === null, 'accent', () => onSelectTab(null)),
        ...sessions.flatMap((session) => [
          chip(
            `tab-${session.sessionId}`,
            `${session.sessionId === activeSessionId ? '▸ ' : ''}${session.label}`,
            session.sessionId === activeSessionId,
            'accent',
            () => onSelectTab(session.sessionId),
          ),
          chip(`close-${session.sessionId}`, '×', false, 'muted', () => onCloseTab(session.sessionId)),
        ]),
        chip('new', '+ new', false, 'muted', () => onSelectSource(selectedSourceIndex)),
      ),
      createElement(
        'box',
        { flexDirection: 'row', gap: 1, flexShrink: 0 },
        sources.map((source, index) => chip(
          `source-${source.id}`,
          `${source.available ? '' : '⊘ '}${index + 1} ${shortLabel(source)}`,
          index === selectedSourceIndex && source.available,
          source.available ? 'text' : 'muted',
          () => { onSelectSource(index); onAttachSource(source); },
        )),
      ),
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
        visible.length === 0
          ? t('No entries in this stream yet. Attach a source or start Metro.', { fg: C.muted, dim: true })
          : visible.map((entry) => createElement(
            'box',
            { key: entry.id, flexDirection: 'row', gap: 1, height: 1, flexShrink: 0 },
            t(clock(entry.timestamp), { fg: C.muted, dim: true }),
            t(entry.level.slice(0, 5).toUpperCase(), { fg: C[logTone(entry.level)] }),
            t(entry.source, { fg: C.muted }),
            t(cut(entry.message, 120), { grow: true, truncate: true }),
          )),
      ),
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

function MetroScreen({ metro, scripts, selectedScript, commandWidth, visibleRows, scrollTop, scrollRef, onSelectScript, onRunScript, onStart, onStop, onReload, onMenu }: {
  metro: { status: MetroStatus; pid?: number };
  scripts: ProjectInfo['scripts'];
  selectedScript: string | null;
  commandWidth: number;
  visibleRows: number;
  scrollTop: number;
  scrollRef: React.RefObject<ScrollBoxRenderable | null>;
  onSelectScript: (name: string) => void;
  onRunScript: (name: string) => void;
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
      'box',
      { flexDirection: 'column', flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'hidden' },
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
      t('Project scripts', { fg: C.muted, bold: true }),
      scripts.length === 0
        ? t('No package.json scripts found', { fg: C.muted, dim: true })
        : createElement(
          'scrollbox',
          {
            ref: scrollRef,
            flexGrow: 1,
            flexBasis: 0,
            minHeight: 0,
            overflow: 'hidden',
            scrollY: true,
            scrollbarOptions: { visible: false, showArrows: false },
          },
          scripts.map((script) => createElement(
            'box',
            {
              key: `script-${script.name}`,
              id: `script-${script.name}`,
              height: 1,
              flexDirection: 'row',
              gap: 1,
              paddingX: 1,
              flexShrink: 0,
              backgroundColor: selectedScript === script.name ? C.selected : undefined,
              onMouseUp: () => { onSelectScript(script.name); onRunScript(script.name); },
            },
            t(selectedScript === script.name ? '▸' : ' ', { fg: selectedScript === script.name ? C.accent : C.muted, shrink: true }),
            t(cut(script.name, 18), { fg: selectedScript === script.name ? C.text : C.muted, bold: selectedScript === script.name, shrink: true }),
            t(cut(script.command, commandWidth), { fg: C.muted, dim: true, shrink: true }),
          )),
        ),
      scripts.length - visibleRows - Math.floor(scrollTop) > 0
        ? t(`↓ ${scripts.length - visibleRows - Math.floor(scrollTop)} more`, { fg: C.muted, dim: true })
        : null,
    ),
  );
}

function BroadcastScreen({ summary, darkEnabled, prompt, promptValue, onReload, onDeepLink, onDarkMode }: {
  summary: BroadcastSummary | null;
  darkEnabled: boolean;
  prompt: PromptKind | null;
  promptValue: string;
  onReload: () => void;
  onDeepLink: () => void;
  onDarkMode: () => void;
}): ReactNode {
  const failed = summary?.results.filter((item) => !item.ok) ?? [];
  const ok = summary ? summary.results.length - failed.length : 0;
  return panel(
    'Broadcast',
    summary ? `${summary.sent} targets` : 'all booted devices',
    createElement(
      'box',
      { flexDirection: 'column', flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'hidden' },
      prompt === 'deepLink' ? createElement(
        'box',
        { flexDirection: 'column', flexShrink: 0 },
        t('Deep link URL', { fg: C.muted }),
        t(`${cut(promptValue, 48)}▌`, { fg: C.text }),
        t('↵ ok · esc cancel', { fg: C.muted, dim: true }),
      ) : createElement(
        'box',
        { flexDirection: 'column', flexShrink: 0 },
        wiredAction('r Reload JS', 'accent', onReload),
        wiredAction('d Open deep link', 'accent', onDeepLink),
        wiredAction(`t Dark mode ${darkEnabled ? 'off' : 'on'}`, 'warn', onDarkMode),
      ),
      t('Last broadcast', { fg: C.muted, bold: true }),
      summary === null
        ? t('No broadcast yet.', { fg: C.muted, dim: true })
        : createElement(
          'box',
          { flexDirection: 'column', flexShrink: 0 },
          t(`${summary.label} · sent ${summary.sent} · ${ok} ok · ${failed.length} failed`, {
            fg: failed.length > 0 ? C.warn : C.good,
          }),
          failed.slice(0, 6).map((item) => t(`✗ ${cut(item.id, 16)}: ${cut(item.message, 52)}`, { fg: C.bad, truncate: true })),
        ),
      t('Keys: r reload · d deep link · t dark mode', { fg: C.muted, dim: true }),
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
    entry('broadcast', 'Broadcast', '5'),
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
  const scriptsScroll = useRef<ScrollBoxRenderable | null>(null);
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
  const [prompt, setPrompt] = useState<PromptKind | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [selectedScript, setSelectedScript] = useState<string | null>(null);
  const [sources, setSources] = useState<LogSource[]>([]);
  const [sessions, setSessions] = useState<LogSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedSourceIndex, setSelectedSourceIndex] = useState(0);
  const [scriptScrollTop, setScriptScrollTop] = useState(0);
  const [broadcastSummary, setBroadcastSummary] = useState<BroadcastSummary | null>(null);
  const [darkEnabled, setDarkEnabled] = useState(false);
  const columns = renderer.width || 80;

  const refreshSources = (): void => {
    void client.call<{ sources: LogSource[] }>('logs.sources')
      .then((result) => {
        if (!mounted.current) return;
        setSources(result.sources);
        setSelectedSourceIndex((current) => Math.min(current, Math.max(0, result.sources.length - 1)));
      })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `logs.sources: ${reasonText(reason)}`, tone: 'bad' });
      });
  };

  const loadSession = (sessionId: string): void => {
    void client.call<{ entries: LogEntry[] }>('logs.list', { sessionId, limit: MAX_LOGS })
      .then((result) => {
        if (mounted.current) setSessions((current) => current.map((session) =>
          session.sessionId === sessionId ? { ...session, entries: result.entries } : session));
      })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `logs.list: ${reasonText(reason)}`, tone: 'bad' });
      });
  };

  const attachSource = (source: LogSource): void => {
    if (!source.available) {
      setNotice({ text: source.reason ?? `${source.label} is unavailable`, tone: 'warn' });
      return;
    }
    void client.call<AttachResult>('logs.attach', { source: source.id })
      .then((result) => {
        if (!mounted.current) return;
        setNotice({ text: result.message || `${source.label}: ${result.started ? 'attached' : 'failed'}`, tone: result.started ? 'good' : 'bad' });
        if (!result.started || !result.sessionId) return;
        setSessions((current) => [...current, {
          sessionId: result.sessionId,
          source: source.id,
          label: source.label,
          entries: [],
        }]);
        setActiveSessionId(result.sessionId);
        loadSession(result.sessionId);
      })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `logs.attach: ${reasonText(reason)}`, tone: 'bad' });
      });
  };

  const closeTab = (sessionId: string): void => {
    void client.call<{ detached: boolean }>('logs.detach', { sessionId })
      .then((result) => {
        if (!mounted.current) return;
        setNotice({ text: result.detached ? `Detached ${sessionId}` : `Could not detach ${sessionId}`, tone: result.detached ? 'good' : 'bad' });
        if (!result.detached) return;
        setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
        setActiveSessionId((current) => current === sessionId ? null : current);
      })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `logs.detach: ${reasonText(reason)}`, tone: 'bad' });
      });
  };

  const clearLogs = (): void => {
    void client.call<{ cleared: true }>('logs.clear', {})
      .then((result) => {
        if (!mounted.current) return;
        setNotice({ text: result.cleared ? 'Logs cleared' : 'Clear failed', tone: result.cleared ? 'good' : 'bad' });
        setEntries([]);
        setSessions((current) => current.map((session) => ({ ...session, entries: [] })));
      })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `logs.clear: ${reasonText(reason)}`, tone: 'bad' });
      });
  };

  const runBroadcast = (method: 'broadcast.reload' | 'broadcast.deepLink' | 'broadcast.darkMode', params: unknown, label: string): void => {
    void client.call<BroadcastResult>(method, params)
      .then((result) => {
        if (!mounted.current) return;
        setBroadcastSummary({ label, sent: result.sent, results: result.results });
        const failed = result.results.filter((item) => !item.ok);
        setNotice({
          text: failed.length > 0
            ? `${label}: ${failed.length} failed · ${failed[0]?.message ?? ''}`
            : `${label}: sent to ${result.sent} targets`,
          tone: failed.length > 0 ? 'bad' : 'good',
        });
      })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `${method}: ${reasonText(reason)}`, tone: 'bad' });
      });
  };

  const runScript = (name: string): void => {
    void client.call<{ started: boolean; pid?: number; message: string }>('project.runScript', { name, cwd: process.cwd() })
      .then((result) => {
        if (mounted.current) setNotice({ text: result.message || name, tone: result.started ? 'good' : 'bad' });
      })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `project.runScript: ${reasonText(reason)}`, tone: 'bad' });
      });
  };

  const refreshDevices = (): void => {
    void client.call<{ devices: DeviceInfo[] }>('devices.list')
      .then((result) => { if (mounted.current) setDevices(result.devices); })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `devices.list: ${reasonText(reason)}`, tone: 'bad' });
      });
  };

  /** Device RPCs return { ok, message }; never infer success from a resolved promise. */
  const invokeDevice = (method: string, params: unknown): void => {
    void client.call<ActionResult>(method, params)
      .then((result) => {
        if (!mounted.current) return;
        setNotice({ text: result.message || (result.ok ? 'done' : 'failed'), tone: result.ok ? 'good' : 'bad' });
        if (result.ok && (method === 'devices.boot' || method === 'devices.shutdown')) refreshDevices();
      })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `${method}: ${reasonText(reason)}`, tone: 'bad' });
      });
  };

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
        if (!live) return;
        setEntries((current) => [...current.slice(-(MAX_LOGS - 1)), entry]);
        setSessions((current) => current.map((session) => {
          const matches = (entry.source === 'metro' && (session.source === 'metro' || session.source === 'console'))
            || entry.source === `logcat:${session.sessionId}`
            || entry.source === `simlog:${session.sessionId}`;
          return matches ? { ...session, entries: [...session.entries.slice(-(MAX_LOGS - 1)), entry] } : session;
        }));
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
    const scripts = project?.scripts ?? [];
    if (scripts.length === 0) { if (selectedScript !== null) setSelectedScript(null); return; }
    if (!scripts.some((script) => script.name === selectedScript)) setSelectedScript(scripts[0]!.name);
  }, [project, selectedScript]);

  useEffect(() => {
    if (active === 'devices' && selectedDevice) {
      devicesScroll.current?.scrollChildIntoView(`dev-${selectedDevice.id}`, { align: 'nearest' });
    }
  }, [active, selectedDevice, filter]);

  useEffect(() => {
    if (active === 'metro' && selectedScript) {
      const box = scriptsScroll.current;
      box?.scrollChildIntoView(`script-${selectedScript}`, { align: 'nearest' });
      if (box) setScriptScrollTop(box.scrollTop);
    }
  }, [active, selectedScript, project]);

  useEffect(() => {
    if (active !== 'environment' || healthRequested.current) return;
    healthRequested.current = true;
    void client.call<{ checks: HealthCheck[] }>('doctor.check')
      .then((result) => { if (mounted.current) setHealth(result.checks); })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `doctor.check: ${reasonText(reason)}`, tone: 'bad' });
      });
  }, [active, client]);

  useEffect(() => {
    if (active === 'logs') refreshSources();
  }, [active, client]);

  const tabIds: Array<string | null> = [null, ...sessions.map((session) => session.sessionId)];
  const cycleTabs = (step: number): void => {
    const index = tabIds.indexOf(activeSessionId);
    const next = tabIds[(index + step + tabIds.length) % tabIds.length] ?? null;
    setActiveSessionId(next);
    if (next) loadSession(next);
  };

  const cycle = (step: number): void => {
    setActive((current) => {
      const index = SCREENS.findIndex((screen) => screen.id === current);
      return SCREENS[(index + step + SCREENS.length) % SCREENS.length]!.id;
    });
  };

  const startPrompt = (kind: PromptKind): void => {
    if (kind !== 'deepLink' && !selectedDevice) { setNotice({ text: 'Select a device first', tone: 'warn' }); return; }
    setPrompt(kind);
    setPromptValue('');
  };

  const submitPrompt = (): void => {
    const value = promptValue.trim();
    if (!value) { setNotice({ text: 'Enter a value first', tone: 'warn' }); return; }
    if (!prompt) return;
    if (prompt === 'deepLink') {
      if (!value.includes(':')) { setNotice({ text: 'Enter a URL, e.g. https://…', tone: 'warn' }); return; }
      runBroadcast('broadcast.deepLink', { url: value }, 'Deep link');
      setPrompt(null);
      return;
    }
    if (!selectedDevice) { setPrompt(null); return; }
    const params = prompt === 'installApp'
      ? { id: selectedDevice.id, platform: selectedDevice.platform, path: value }
      : { id: selectedDevice.id, platform: selectedDevice.platform, app: value };
    invokeDevice(prompt === 'installApp' ? 'devices.installApp' : 'devices.runApp', params);
    setPrompt(null);
  };

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl || key.meta || key.eventType === 'release') return;
    const name = key.name;
    if (prompt) {
      key.preventDefault();
      if (name === 'escape' || name === 'esc') {
        setPrompt(null);
        setNotice({ text: 'Cancelled', tone: 'muted' });
      } else if (name === 'return' || name === 'enter') {
        submitPrompt();
      } else if (name === 'backspace') {
        setPromptValue((current) => current.slice(0, -1));
      } else if (name.length === 1) {
        setPromptValue((current) => current + (name === 'space' ? ' ' : name));
      }
      return;
    }
    if (name === 'q') { renderer.destroy(); return; }
    if (name === 'tab' || name === '[' || name === ']') {
      if (active === 'logs') { key.preventDefault(); cycleTabs(name === '[' ? -1 : 1); return; }
    }
    if (name === 'tab' || name === '[' || name === 'left' || name === 'right') {
      key.preventDefault();
      cycle(name === '[' || name === 'left' ? -1 : 1);
      return;
    }
    if (active === 'logs' && /^[1-5]$/.test(name)) {
      key.preventDefault();
      const index = Number(name) - 1;
      setSelectedSourceIndex(index);
      if (sources[index]) attachSource(sources[index]!);
      return;
    }
    if (/^[1-5]$/.test(name)) {
      key.preventDefault();
      setActive(SCREENS[Number(name) - 1]!.id);
      return;
    }
    if (active === 'broadcast') {
      if (name === 'r') { key.preventDefault(); runBroadcast('broadcast.reload', {}, 'Reload JS'); return; }
      if (name === 'd') { key.preventDefault(); startPrompt('deepLink'); return; }
      if (name === 't') {
        key.preventDefault();
        const enabled = !darkEnabled;
        setDarkEnabled(enabled);
        runBroadcast('broadcast.darkMode', { enabled }, `Dark mode ${enabled ? 'on' : 'off'}`);
        return;
      }
    }
    if (name === 'up' || name === 'down') {
      if (active === 'devices' && ordered.length > 0) {
        key.preventDefault();
        const index = ordered.findIndex((device) => device.id === selectedDevice?.id);
        const next = Math.max(0, Math.min(ordered.length - 1, (index < 0 ? 0 : index) + (name === 'up' ? -1 : 1)));
        setSelectedId(ordered[next]!.id);
      } else if (active === 'metro' && project && project.scripts.length > 0) {
        key.preventDefault();
        const scripts = project.scripts;
        const index = scripts.findIndex((script) => script.name === selectedScript);
        const next = Math.max(0, Math.min(scripts.length - 1, (index < 0 ? 0 : index) + (name === 'up' ? -1 : 1)));
        setSelectedScript(scripts[next]!.name);
      } else if (active === 'logs' && sources.length > 0) {
        key.preventDefault();
        setSelectedSourceIndex((current) => Math.max(0, Math.min(sources.length - 1, current + (name === 'up' ? -1 : 1))));
      }
      return; // other screens keep focus so their scrollbox handles arrows
    }
    if (name === 'return' || name === 'enter') {
      if (active === 'metro' && selectedScript) { key.preventDefault(); runScript(selectedScript); }
      else if (active === 'logs' && sources[selectedSourceIndex]) { key.preventDefault(); attachSource(sources[selectedSourceIndex]!); }
      return;
    }
    if (name === 'i') { setActive('environment'); return; }
    if (active === 'logs' && name === 'w') {
      key.preventDefault();
      if (activeSessionId) closeTab(activeSessionId);
      else setNotice({ text: 'No session tab to close', tone: 'muted' });
      return;
    }
    if (active === 'devices' && selectedDevice) {
      const params = { id: selectedDevice.id, platform: selectedDevice.platform };
      if (name === 'b') { invokeDevice('devices.boot', params); return; }
      if (name === 'p') { invokeDevice('devices.shutdown', params); return; }
      if (name === 'f') { startPrompt('installApp'); return; }
      if (name === 'a') { startPrompt('runApp'); return; }
    }
    const target = selectedDevice ? selectedDevice.name : 'no device selected';
    switch (name) {
      case 'r': invoke('metro.reload', {}, `JS reload → ${target}`); break;
      case 'd': invoke('metro.devMenu', {}, `Dev menu → ${target}`); break;
      case 's': invoke('metro.start', { resetCache: false }, 'Metro start requested', () => setMetro({ status: 'running' })); break;
      case 'x': invoke('metro.stop', {}, 'Metro stop requested', () => setMetro({ status: 'stopped' })); break;
      case 'c': clearLogs(); break;
      default: break;
    }
  });

  const target = selectedDevice?.name ?? 'no device selected';
  let screen: ReactNode;
  switch (active) {
    case 'logs':
      screen = createElement(LogsScreen, {
        entries,
        sources,
        sessions,
        activeSessionId,
        selectedSourceIndex,
        compact: columns < 120,
        onSelectTab: (sessionId: string | null) => {
          setActiveSessionId(sessionId);
          if (sessionId) loadSession(sessionId);
        },
        onCloseTab: closeTab,
        onAttachSource: attachSource,
        onSelectSource: setSelectedSourceIndex,
      });
      break;
    case 'metro':
      screen = createElement(MetroScreen, {
        metro,
        scripts: project?.scripts ?? [],
        selectedScript,
        commandWidth: columns >= 120 ? 64 : 28,
        visibleRows: Math.max(3, (renderer.height || 24) - 19),
        scrollTop: scriptScrollTop,
        scrollRef: scriptsScroll,
        onSelectScript: setSelectedScript,
        onRunScript: runScript,
        onStart: () => invoke('metro.start', { resetCache: false }, 'Metro start requested', () => setMetro({ status: 'running' })),
        onStop: () => invoke('metro.stop', {}, 'Metro stop requested', () => setMetro({ status: 'stopped' })),
        onReload: () => invoke('metro.reload', {}, `JS reload → ${target}`),
        onMenu: () => invoke('metro.devMenu', {}, `Dev menu → ${target}`),
      });
      break;
    case 'environment':
      screen = createElement(EnvironmentScreen, { health });
      break;
    case 'broadcast':
      screen = createElement(BroadcastScreen, {
        summary: broadcastSummary,
        darkEnabled,
        prompt,
        promptValue,
        onReload: () => runBroadcast('broadcast.reload', {}, 'Reload JS'),
        onDeepLink: () => startPrompt('deepLink'),
        onDarkMode: () => {
          const enabled = !darkEnabled;
          setDarkEnabled(enabled);
          runBroadcast('broadcast.darkMode', { enabled }, `Dark mode ${enabled ? 'on' : 'off'}`);
        },
      });
      break;
    default:
      // Keep the device name + platform + state on one line: 27 cols of chrome, 19 of row overhead.
      const actionWidth = columns >= 120 ? 28 : 20;
      const nameWidth = Math.max(10, Math.min(48, columns - 27 - actionWidth - 19));
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
          width: actionWidth,
          prompt,
          promptValue,
          onBoot: () => { if (selectedDevice) invokeDevice('devices.boot', { id: selectedDevice.id, platform: selectedDevice.platform }); },
          onShutdown: () => { if (selectedDevice) invokeDevice('devices.shutdown', { id: selectedDevice.id, platform: selectedDevice.platform }); },
          onInstall: () => startPrompt('installApp'),
          onRunApp: () => startPrompt('runApp'),
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
        height: 3,
        backgroundColor: C.surface,
        paddingX: 2,
        flexDirection: 'column',
        justifyContent: 'center',
      },
      t(`${notice.tone === 'bad' ? '✗' : '›'} ${notice.text}`, { fg: C[notice.tone], truncate: true }),
      t('1-5/←→ screens · ↑↓ · b/p/f/a device · r/d/t cast · s/x metro · q quit', {
        fg: C.muted,
        dim: true,
        truncate: true,
      }),
      t('Logs: 1-5 source · ↑↓ pick · Enter attach · Tab/[ ] tabs · w close · c clear', {
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
