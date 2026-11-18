import type { PluginContext, RpcMethod } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin from './index.js';

function setup() {
  const rpcs = new Map<string, RpcMethod>();
  const spawn = vi.fn(async () => ({ id: 'metro', pid: 1234 }));
  const stop = vi.fn(async () => {});
  const write = vi.fn(async () => {});
  const ctx = {
    bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    processes: { spawn, exec: vi.fn(), stop, write },
    registerRpc: (name: string, method: RpcMethod) => { rpcs.set(name, method); },
    registerCommand: vi.fn(),
  } as unknown as PluginContext;
  return { ctx, rpcs, spawn, stop, write };
}

describe('plugin-metro', () => {
  it('starts Metro with a deterministic id and reset-cache flag', async () => {
    const { ctx, rpcs, spawn } = setup();
    await plugin.setup(ctx);

    const result = await rpcs.get('metro.start')!.handler({ resetCache: true, cwd: '/app' });
    expect(result).toEqual({ started: true, pid: 1234 });
    expect(spawn).toHaveBeenCalledWith('metro', 'npx', ['react-native', 'start', '--reset-cache'], { cwd: '/app' });
  });

  it('stops Metro via the process gateway', async () => {
    const { ctx, rpcs, stop } = setup();
    await plugin.setup(ctx);

    expect(await rpcs.get('metro.stop')!.handler({})).toEqual({ stopped: true });
    expect(stop).toHaveBeenCalledWith('metro');
  });

  it('sends reload and dev-menu keys to Metro stdin', async () => {
    const { ctx, rpcs, write } = setup();
    await plugin.setup(ctx);

    expect(await rpcs.get('metro.reload')!.handler({})).toEqual({ sent: true });
    expect(await rpcs.get('metro.devMenu')!.handler({})).toEqual({ sent: true });
    expect(write).toHaveBeenNthCalledWith(1, 'metro', 'r');
    expect(write).toHaveBeenNthCalledWith(2, 'metro', 'd');
  });

  it('does not throw when Metro is already running', async () => {
    const { ctx, rpcs, spawn } = setup();
    await plugin.setup(ctx);
    spawn.mockRejectedValueOnce(new Error('already registered'));

    const result = await rpcs.get('metro.start')!.handler({ resetCache: false, cwd: undefined });
    expect(result).toEqual({ started: false, pid: undefined });
  });
});
