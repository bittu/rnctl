import type { LogEntry, PluginContext, RpcMethod } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin from './index.js';

function setup() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const emitted: Array<{ topic: string; payload: unknown }> = [];
  const rpcs = new Map<string, RpcMethod>();
  const ctx = {
    bus: {
      on: (topic: string, listener: (payload: unknown) => void) => {
        listeners.set(topic, listener);
        return () => { listeners.delete(topic); };
      },
      off: vi.fn(),
      emit: async (topic: string, payload: unknown) => { emitted.push({ topic, payload }); },
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    processes: { spawn: vi.fn(), exec: vi.fn(), stop: vi.fn() },
    registerRpc: (name: string, method: RpcMethod) => { rpcs.set(name, method); },
    registerCommand: vi.fn(),
  } as unknown as PluginContext;
  return { ctx, listeners, emitted, rpcs };
}

describe('plugin-logs', () => {
  it('turns process output into typed log entries', async () => {
    const { ctx, listeners, emitted, rpcs } = setup();
    await plugin.setup(ctx);

    listeners.get('process:stdout')!({ id: 'metro', chunk: 'alpha\nbeta\n' });
    listeners.get('process:stderr')!({ id: 'adb', chunk: 'gamma\n' });
    listeners.get('process:exit')!({ id: 'metro', code: 0, signal: null });

    const result = await rpcs.get('logs.list')!.handler({ level: undefined, limit: 100 });
    const entries = (result as { entries: LogEntry[] }).entries;
    expect(entries.map((entry) => [entry.source, entry.message, entry.level])).toEqual([
      ['metro', 'alpha', 'info'],
      ['metro', 'beta', 'info'],
      ['adb', 'gamma', 'warn'],
    ]);
    expect(emitted.filter((event) => event.topic === 'log:entry')).toHaveLength(3);
  });

  it('filters by level and clears the buffer', async () => {
    const { ctx, listeners, rpcs } = setup();
    await plugin.setup(ctx);
    listeners.get('process:stderr')!({ id: 'ios', chunk: 'boom\n' });

    const filtered = await rpcs.get('logs.list')!.handler({ level: 'warn', limit: 10 });
    expect((filtered as { entries: LogEntry[] }).entries).toHaveLength(1);

    expect(await rpcs.get('logs.clear')!.handler({})).toEqual({ cleared: true });
    const empty = await rpcs.get('logs.list')!.handler({ level: undefined, limit: 10 });
    expect((empty as { entries: LogEntry[] }).entries).toEqual([]);
  });
});
