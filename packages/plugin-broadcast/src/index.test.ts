import type { PluginContext, RpcMethod } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin from './index.js';

function setup() {
  const rpcs = new Map<string, RpcMethod>();
  const commands = new Map<string, { action: (args: string[], ctx: PluginContext) => Promise<void> }>();
  const exec = vi.fn(async (command: string) => {
    if (command === 'adb') {
      return { stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '', exitCode: 0 };
    }
    return {
      stdout: JSON.stringify({ devices: { ios: [{ udid: 'IOS-1', state: 'Booted', isAvailable: true }] } }),
      stderr: '',
      exitCode: 0,
    };
  });
  const write = vi.fn(async () => {});
  const ctx = {
    bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    processes: { spawn: vi.fn(), exec, stop: vi.fn(), write, isRunning: vi.fn() },
    registerRpc: (name: string, method: RpcMethod) => { rpcs.set(name, method); },
    registerCommand: (command: { name: string; action: (args: string[], ctx: PluginContext) => Promise<void> }) => {
      commands.set(command.name, command);
    },
  } as unknown as PluginContext;
  return { ctx, rpcs, commands, exec, write };
}

describe('plugin-broadcast', () => {
  it('opens a deep link on every booted device', async () => {
    const { ctx, rpcs, exec } = setup();
    await plugin.setup(ctx);
    const result = await rpcs.get('broadcast.deepLink')!.handler({ url: 'myapp://home' }) as { sent: number };
    expect(result.sent).toBe(2);
    expect(exec).toHaveBeenCalledWith('adb', [
      '-s', 'emulator-5554', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'myapp://home',
    ]);
    expect(exec).toHaveBeenCalledWith('xcrun', ['simctl', 'openurl', 'IOS-1', 'myapp://home']);
  });

  it('toggles dark mode on every booted device', async () => {
    const { ctx, rpcs, exec } = setup();
    await plugin.setup(ctx);
    const result = await rpcs.get('broadcast.darkMode')!.handler({ enabled: true }) as { sent: number };
    expect(result.sent).toBe(2);
    expect(exec).toHaveBeenCalledWith('adb', ['-s', 'emulator-5554', 'shell', 'cmd', 'uimode', 'night', 'yes']);
    expect(exec).toHaveBeenCalledWith('xcrun', ['simctl', 'ui', 'IOS-1', 'appearance', 'dark']);
  });

  it('reloads Metro and Android apps', async () => {
    const { ctx, rpcs, exec, write } = setup();
    await plugin.setup(ctx);
    const result = await rpcs.get('broadcast.reload')!.handler({}) as { sent: number };
    expect(result.sent).toBe(2);
    expect(exec).toHaveBeenCalledWith('adb', ['-s', 'emulator-5554', 'shell', 'input', 'text', 'rr']);
    expect(write).toHaveBeenCalledWith('metro', 'r');
  });
});
