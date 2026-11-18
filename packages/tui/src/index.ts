/**
 * Full-screen mission control layout:
 *   header ........ brand + daemon status
 *   devices ....... primary list; ↑/↓ or 1-9 select a device
 *   side stack .... Metro status + live logs (i toggles the doctor summary)
 *   footer ........ last action/error + shortcut legend
 * Keys: ↑/↓ navigate · 1-9 pick · r reload · d dev menu · s start · x stop · c clear logs · i env · q quit.
 * Without a TTY, input hooks stay inactive so the same panels render read-only.
 */
import { RpcClient } from '@rnctl/core';
import type { DeviceInfo, LogEntry, ProcessExit } from '@rnctl/sdk';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';

type Tone = 'cyan' | 'green' | 'yellow' | 'red' | 'magenta' | 'gray' | 'black';
type MetroStatus = 'unknown' | 'running' | 'stopped';
interface Notice { text: string; tone: Tone }
interface HealthCheck { name: string; ok: boolean; detail: string }

const MAX_LOGS = 200;

function cut(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Bordered section with a consistent title bar, used by all three panels. */
function Panel({ title, meta, tone, grow, children }: {
  title: string;
  meta?: string;
  tone: Tone;
  grow?: boolean;
  children?: ReactNode;
}) {
  return createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: tone,
      paddingX: 1,
      overflow: 'hidden',
      flexGrow: grow ? 1 : undefined,
      minHeight: 0,
    },
    createElement(
      Box,
      {
        borderStyle: 'single',
        borderBottom: true,
        borderBottomColor: tone,
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 1,
      },
      createElement(Text, { bold: true, color: tone }, title),
      meta ? createElement(Text, { dimColor: true }, meta) : null,
    ),
    children,
  );
}

function shortcut(key: string, label: string, index: number) {
  return createElement(
    Box,
    { key: index, flexDirection: 'row', gap: 1 },
    createElement(Text, { bold: true, color: 'yellow' }, key),
    createElement(Text, { dimColor: true }, label),
  );
}

function Dashboard({ client, interactive }: { client: RpcClient; interactive: boolean }) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const mounted = useRef(true);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [metro, setMetro] = useState<{ status: MetroStatus; pid?: number }>({ status: 'unknown' });
  const [notice, setNotice] = useState<Notice>({ text: 'ready', tone: 'gray' });
  const [health, setHealth] = useState<HealthCheck[] | undefined>(undefined);
  const [showHealth, setShowHealth] = useState(false);

  /** Fire an action and surface failures in the footer instead of crashing. */
  const invoke = (method: string, params: unknown, message: string, onDone?: () => void): void => {
    void client.call(method, params)
      .then(() => {
        if (!mounted.current) return;
        setNotice({ text: message, tone: 'green' });
        onDone?.();
      })
      .catch((reason: unknown) => {
        if (mounted.current) setNotice({ text: `${method}: ${reasonText(reason)}`, tone: 'red' });
      });
  };

  useEffect(() => {
    let active = true;
    const fail = (method: string, reason: unknown): void => {
      if (active) setNotice({ text: `${method}: ${reasonText(reason)}`, tone: 'red' });
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

  useInput((input, key) => {
    if (key.upArrow) {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((current) => Math.min(Math.max(0, devices.length - 1), current + 1));
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const index = Number(input) - 1;
      if (index < devices.length) setSelected(index);
      return;
    }
    const device = devices[selected];
    const target = device ? device.name : 'no device selected';
    switch (input.toLowerCase()) {
      case 'r': invoke('metro.reload', {}, `JS reload → ${target}`); break;
      case 'd': invoke('metro.devMenu', {}, `Dev menu → ${target}`); break;
      case 's': invoke('metro.start', { resetCache: false }, 'Metro start requested', () => setMetro({ status: 'running' })); break;
      case 'x': invoke('metro.stop', {}, 'Metro stop requested', () => setMetro({ status: 'stopped' })); break;
      case 'c': invoke('logs.clear', {}, 'Logs cleared', () => setEntries([])); break;
      case 'i':
        setShowHealth((current) => !current);
        if (health === undefined) {
          void client.call<{ checks: HealthCheck[] }>('doctor.check')
            .then((result) => { if (mounted.current) setHealth(result.checks); })
            .catch((reason: unknown) => {
              if (mounted.current) setNotice({ text: `doctor.check: ${reasonText(reason)}`, tone: 'red' });
            });
        }
        break;
      case 'q': exit(); break;
      default: break;
    }
  }, { isActive: interactive });

  const room = Math.max(4, rows - 13);
  const visibleDevices = devices.slice(0, room);
  const visibleLogs = entries.slice(-Math.max(3, Math.floor(room / 2)));
  const booted = devices.filter((device) => device.state === 'booted').length;
  const metroTone: Tone = metro.status === 'running' ? 'green' : metro.status === 'stopped' ? 'red' : 'yellow';
  const metroGlyph = metro.status === 'running' ? '●' : metro.status === 'stopped' ? '○' : '◐';

  const deviceRows = visibleDevices.length === 0
    ? [createElement(Text, { dimColor: true }, 'No devices discovered. Boot a simulator or connect an emulator.')]
    : visibleDevices.map((device, index) => {
      const active = index === selected;
      const stateTone: Tone = active ? 'black' : device.state === 'booted' ? 'green' : 'gray';
      return createElement(
        Box,
        { key: device.id, flexDirection: 'row', gap: 1, backgroundColor: active ? 'cyan' : undefined },
        createElement(Box, { width: 2, flexShrink: 0 }, createElement(Text, { color: active ? 'black' : 'yellow', bold: true }, String(index + 1).padStart(2, ' '))),
        createElement(Box, { width: 1, flexShrink: 0 }, createElement(Text, { color: stateTone }, device.state === 'booted' ? '●' : '○')),
        createElement(Box, { flexGrow: 1, flexShrink: 1, overflow: 'hidden' }, createElement(Text, { color: active ? 'black' : 'white', bold: active, wrap: 'truncate' }, device.name)),
        createElement(Box, { width: 4, flexShrink: 0 }, createElement(Text, { color: active ? 'black' : undefined, dimColor: !active }, device.platform === 'ios' ? 'iOS' : 'AND')),
        createElement(Box, { width: 8, flexShrink: 0 }, createElement(Text, { color: active ? 'black' : undefined, dimColor: !active }, device.state)),
      );
    });

  const logTone = (level: LogEntry['level']): Tone => level === 'error' ? 'red' : level === 'warn' ? 'yellow' : level === 'debug' ? 'gray' : 'cyan';
  const logRows = visibleLogs.length === 0
    ? [createElement(Text, { dimColor: true }, 'No log entries yet. Start Metro to see activity here.')]
    : visibleLogs.map((entry) => createElement(
      Box,
      { key: entry.id, flexDirection: 'row', gap: 1 },
      createElement(Box, { width: 5, flexShrink: 0 }, createElement(Text, { dimColor: true }, clock(entry.timestamp))),
      createElement(Box, { width: 5, flexShrink: 0 }, createElement(Text, { color: logTone(entry.level) }, entry.level.slice(0, 5).toUpperCase())),
      createElement(Box, { flexGrow: 1, overflow: 'hidden' }, createElement(Text, { wrap: 'truncate' }, `${entry.source} ${entry.message}`)),
    ));

  const healthRows = health === undefined
    ? [createElement(Text, { dimColor: true }, 'Checking environment…')]
    : health.map((check) => createElement(
      Box,
      { key: check.name, flexDirection: 'row', gap: 1 },
      createElement(Text, { color: check.ok ? 'green' : 'red' }, check.ok ? '✓' : '✗'),
      createElement(Box, { width: 11, flexShrink: 0 }, createElement(Text, { color: check.ok ? undefined : 'red' }, cut(check.name, 11))),
      createElement(Box, { flexGrow: 1, overflow: 'hidden' }, createElement(Text, { dimColor: true, wrap: 'truncate' }, check.detail)),
    ));

  return createElement(
    Box,
    { flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden', paddingX: 1, paddingTop: 1, gap: 1 },
    createElement(
      Box,
      { borderStyle: 'round', borderColor: 'cyan', paddingX: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
      createElement(
        Box,
        { flexDirection: 'row', gap: 1 },
        createElement(Text, { bold: true, color: 'cyan' }, '◆ rnctl'),
        createElement(Text, { dimColor: true }, '// MISSION CONTROL'),
      ),
      createElement(
        Box,
        { flexDirection: 'row', gap: 1 },
        createElement(Text, { color: 'green' }, '● daemon'),
        createElement(Text, { dimColor: true }, 'v0.1.0'),
      ),
    ),
    createElement(
      Box,
      { flexDirection: 'row', flexGrow: 1, gap: 1, overflow: 'hidden', minHeight: 0 },
      createElement(
        Panel,
        { title: 'DEVICES', meta: `${devices.length} found · ${booted} booted`, tone: 'cyan', grow: true },
        ...deviceRows,
      ),
      createElement(
        Box,
        { flexDirection: 'column', width: '42%', gap: 1, overflow: 'hidden', minHeight: 0 },
        createElement(
          Panel,
          { title: 'METRO', meta: metro.status, tone: 'magenta' },
          createElement(
            Box,
            { flexDirection: 'row', gap: 1 },
            createElement(Text, { color: metroTone, bold: true }, metroGlyph),
            createElement(Text, { color: metroTone, bold: true }, metro.status),
            createElement(Text, { dimColor: true }, metro.pid === undefined ? '' : `pid ${metro.pid}`),
          ),
          createElement(Text, { dimColor: true }, 's start · x stop · r reload · d menu'),
        ),
        createElement(
          Panel,
          {
            title: showHealth ? 'ENVIRONMENT' : 'LIVE LOGS',
            meta: showHealth
              ? health ? `${health.filter((check) => check.ok).length}/${health.length} ok` : 'checking…'
              : `${entries.length} entries`,
            tone: 'yellow',
            grow: true,
          },
          ...(showHealth ? healthRows : logRows),
        ),
      ),
    ),
    createElement(
      Box,
      { borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexDirection: 'column' },
      createElement(
        Box,
        { flexDirection: 'row', gap: 1 },
        createElement(Text, { color: notice.tone, bold: true }, notice.tone === 'red' ? '✗' : '›'),
        createElement(Text, { color: notice.tone, wrap: 'truncate' }, notice.text),
      ),
      interactive
        ? createElement(
          Box,
          { flexDirection: 'row', gap: 2, flexWrap: 'wrap' },
          shortcut('↑↓', 'nav', 0),
          shortcut('1-9', 'pick', 1),
          shortcut('r', 'reload', 2),
          shortcut('d', 'menu', 3),
          shortcut('s/x', 'metro', 4),
          shortcut('c', 'clear', 5),
          shortcut('i', 'env', 6),
          shortcut('q', 'quit', 7),
        )
        : createElement(Text, { dimColor: true }, 'Read-only view — keyboard shortcuts need an interactive terminal.'),
    ),
  );
}

export async function renderDashboard(client?: RpcClient): Promise<void> {
  const rpc = client ?? await RpcClient.connect();
  const interactive = process.stdin.isTTY === true && typeof process.stdin.setRawMode === 'function';
  const instance = render(createElement(Dashboard, { client: rpc, interactive }));
  await instance.waitUntilExit();
  rpc.close();
}
