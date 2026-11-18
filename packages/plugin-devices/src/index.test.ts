import type { PluginContext, RpcMethod } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin, { parseAdb, parseAvds, parseSimctl } from './index.js';

const simctlJson = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      { name: 'iPhone 16', udid: 'IOS-1', state: 'Booted', isAvailable: true },
      { name: 'Unavailable', udid: 'IOS-2', state: 'Shutdown', isAvailable: false },
    ],
  },
});

const adbOutput = [
  'List of devices attached',
  'emulator-5554\tdevice product:pixel model:Pixel_8',
  '',
].join('\n');

describe('device parsers', () => {
  it('parses simctl JSON and skips unavailable devices', () => {
    expect(parseSimctl(simctlJson)).toEqual([
      { id: 'IOS-1', name: 'iPhone 16', platform: 'ios', state: 'booted' },
    ]);
  });

  it('parses adb devices and avd lists', () => {
    expect(parseAdb(adbOutput)).toEqual([
      { id: 'emulator-5554', name: 'Pixel_8', platform: 'android', state: 'booted' },
    ]);
    expect(parseAvds('Pixel_9\nPixel_8a\n')).toHaveLength(2);
  });
});

describe('plugin-devices', () => {
  it('registers devices.list and survives a failing adb', async () => {
    let rpc: RpcMethod | undefined;
    const exec = vi.fn(async (command: string) => {
      if (command === 'adb') throw new Error('adb not installed');
      return { stdout: simctlJson, stderr: '', exitCode: 0 };
    });
    const ctx = {
      bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processes: { spawn: vi.fn(), exec, stop: vi.fn() },
      registerRpc: (_name: string, method: RpcMethod) => { rpc = method; },
      registerCommand: vi.fn(),
    } as unknown as PluginContext;

    await plugin.setup(ctx);
    expect(rpc).toBeDefined();
    const result = await rpc!.handler({});
    expect(result).toHaveProperty('devices');
    expect(Array.isArray((result as { devices: unknown[] }).devices)).toBe(true);
  });
});
