import {
  definePlugin,
  z,
  type LogEntry,
  type LogLevel,
  type ProcessExit,
  type ProcessOutput,
} from '@rnctl/sdk';

const MAX_ENTRIES = 1000;
const LOG_SOURCE = ['metro', 'android', 'ios', 'console', 'network'] as const;
type LogSource = typeof LOG_SOURCE[number];

interface Session {
  id: string;
  source: LogSource;
  processId?: string;
  viewSource?: string;
}

export default definePlugin({
  name: '@rnctl/plugin-logs',
  version: '0.1.0',
  description: 'Unified native + JS log multiplexing',
  async setup(ctx) {
    // shortcut: network inspection belongs to the Phase 3 network plugin; no fake stream here.
    const entries: LogEntry[] = [];
    const partials = new Map<string, string>();
    const sessions = new Map<string, Session>();
    let sequence = 0;
    let sessionCount = 0;

    const append = (source: string, message: string, level: LogLevel): void => {
      if (message.length === 0) return;
      const entry: LogEntry = {
        id: String(++sequence),
        timestamp: Date.now(),
        source,
        level,
        message,
      };
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries.shift();
      void ctx.bus.emit('log:entry', entry);
    };

    const consume = (payload: ProcessOutput, level: LogLevel): void => {
      const text = (partials.get(payload.id) ?? '') + payload.chunk;
      const lines = text.split('\n');
      partials.set(payload.id, lines.pop() ?? '');
      for (const line of lines) append(payload.id, line, level);
    };

    ctx.bus.on<ProcessOutput>('process:stdout', (payload) => consume(payload, 'info'));
    ctx.bus.on<ProcessOutput>('process:stderr', (payload) => consume(payload, 'warn'));
    ctx.bus.on<ProcessExit>('process:exit', ({ id }) => {
      const remaining = partials.get(id);
      if (remaining) append(id, remaining, 'info');
      partials.delete(id);
    });

    ctx.registerRpc('logs.list', {
      inputSchema: z.object({
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        limit: z.number().int().positive().default(100),
        sessionId: z.string().optional(),
      }),
      handler: async ({ level, limit, sessionId }) => {
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const source = session ? session.processId ?? session.viewSource ?? session.source : undefined;
        return {
          entries: entries
            .filter((entry) => !level || entry.level === level)
            .filter((entry) => !source || entry.source === source)
            .slice(-limit),
        };
      },
    });

    ctx.registerRpc('logs.clear', {
      inputSchema: z.object({}),
      handler: async () => {
        entries.length = 0;
        return { cleared: true };
      },
    });

    ctx.registerRpc('logs.sources', {
      inputSchema: z.object({}),
      handler: async () => {
        const metroRunning = await ctx.processes.isRunning('metro');
        let androidRunning = false;
        try {
          const devices = await ctx.processes.exec('adb', ['devices', '-l']);
          androidRunning = devices.stdout.split('\n').slice(1).some((line) => /\s+device\b/.test(line));
        } catch { /* adb unavailable */ }

        let iosRunning = false;
        if (process.platform === 'darwin') {
          try {
            const simctl = await ctx.processes.exec('xcrun', ['simctl', 'list', 'devices', '-j']);
            const parsed = JSON.parse(simctl.stdout) as { devices?: Record<string, Array<{ state?: string }>> };
            iosRunning = Object.values(parsed.devices ?? {}).some((list) => list.some((device) => device.state === 'Booted'));
          } catch { /* simctl unavailable */ }
        }

        return {
          sources: [
            { id: 'metro', label: 'Metro', available: metroRunning },
            { id: 'console', label: 'JS console', available: metroRunning },
            { id: 'android', label: 'Android app', available: androidRunning },
            { id: 'ios', label: 'iOS app', available: iosRunning },
            { id: 'network', label: 'Network', available: false, reason: 'Network inspection arrives with the Phase 3 plugin' },
          ],
        };
      },
    });

    ctx.registerRpc('logs.attach', {
      inputSchema: z.object({ source: z.enum(LOG_SOURCE) }),
      handler: async ({ source }) => {
        if (source === 'network') {
          return { sessionId: '', started: false, message: 'Network inspection arrives with the Phase 3 plugin' };
        }
        const id = `${source}-${++sessionCount}`;
        const session: Session = { id, source };
        if (source === 'console') session.viewSource = 'metro';

        if (source === 'android' || source === 'ios') {
          const processId = source === 'android' ? `logcat:${id}` : `simlog:${id}`;
          const command = source === 'android'
            ? 'adb'
            : 'xcrun';
          const args = source === 'android'
            ? ['logcat']
            : ['simctl', 'spawn', 'booted', 'log', 'stream', '--level=debug'];
          try {
            const handle = await ctx.processes.spawn(processId, command, args);
            session.processId = processId;
            sessions.set(id, session);
            return { sessionId: id, started: true, message: `${source} logs attached (pid ${handle.pid ?? 'unknown'})` };
          } catch (error) {
            return { sessionId: '', started: false, message: String(error) };
          }
        }

        sessions.set(id, session);
        return { sessionId: id, started: true, message: `${source} logs attached` };
      },
    });

    ctx.registerRpc('logs.detach', {
      inputSchema: z.object({ sessionId: z.string() }),
      handler: async ({ sessionId }) => {
        const session = sessions.get(sessionId);
        if (!session) return { detached: false };
        if (session.processId) await ctx.processes.stop(session.processId);
        sessions.delete(sessionId);
        return { detached: true };
      },
    });
  },
});
