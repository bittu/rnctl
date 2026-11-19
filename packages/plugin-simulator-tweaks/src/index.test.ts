import type { PluginContext, RpcMethod } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import { commands } from './index.js';

describe('simulator tweak commands', () => {
  it('builds platform-specific argument arrays', () => {
    expect(commands.iosLocation('IOS-1', 12.5, -77.2)).toEqual(['simctl', 'location', 'IOS-1', 'set', '12.5,-77.2']);
    expect(commands.androidGeo('emulator-5554', 12.5, -77.2)).toEqual(['emu', 'geo', 'fix', '-77.2', '12.5']);
    expect(commands.iosAppearance('IOS-1', 'dark')).toEqual(['simctl', 'ui', 'IOS-1', 'appearance', 'dark']);
    expect(commands.androidAppearance('emulator-5554', 'light')).toEqual(['shell', 'cmd', 'uimode', 'night', 'no']);
  });

  it('builds the clean status bar preset', () => {
    const args = commands.iosStatusBar('IOS-1', ['--time', '9:41', '--batteryLevel', '100']);
    expect(args).toEqual(['simctl', 'status_bar', 'IOS-1', 'override', '--time', '9:41', '--batteryLevel', '100']);
  });

  it('marks GPS injection unavailable on physical Android devices', async () => {
    const rpcs = new Map<string, RpcMethod>();
    const exec = vi.fn(async (command: string) => ({
      stdout: command === 'adb'
        ? 'List of devices attached\nZX1G22B7K8\tdevice\n'
        : JSON.stringify({ devices: {} }),
      stderr: '',
      exitCode: 0,
    }));
    const ctx = {
      bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processes: { spawn: vi.fn(), exec, stop: vi.fn(), write: vi.fn(), isRunning: vi.fn() },
      registerRpc: (name: string, method: RpcMethod) => { rpcs.set(name, method); },
      registerCommand: vi.fn(),
    } as unknown as PluginContext;

    const { default: plugin } = await import('./index.js');
    await plugin.setup(ctx);
    const result = await rpcs.get('tweaks.location.set')!.handler({
      id: 'ZX1G22B7K8', platform: 'android', lat: 1, lon: 2,
    }) as { status: string };
    expect(result.status).toBe('unavailable');
  });
});
