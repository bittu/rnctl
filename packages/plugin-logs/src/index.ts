import { definePlugin, z, type LogEntry, type LogLevel, type ProcessExit, type ProcessOutput } from '@rnctl/sdk';

const MAX_ENTRIES = 1000;

export default definePlugin({
  name: '@rnctl/plugin-logs',
  version: '0.1.0',
  description: 'Unified native + JS log multiplexing',
  async setup(ctx) {
    // shortcut: stack-trace folding is not implemented; raw lines are kept intact.
    const entries: LogEntry[] = [];
    const partials = new Map<string, string>();
    let sequence = 0;

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
      }),
      handler: async ({ level, limit }) => ({
        entries: entries.filter((entry) => !level || entry.level === level).slice(-limit),
      }),
    });

    ctx.registerRpc('logs.clear', {
      inputSchema: z.object({}),
      handler: async () => {
        entries.length = 0;
        return { cleared: true };
      },
    });
  },
});
