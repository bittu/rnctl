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

function setupActions() {
  const rpcs = new Map<string, RpcMethod>();
  const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  const spawn = vi.fn(async (id: string) => ({ id, pid: 99 }));
  const ctx = {
    bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    processes: { spawn, exec, stop: vi.fn(), write: vi.fn() },
    registerRpc: (name: string, method: RpcMethod) => { rpcs.set(name, method); },
    registerCommand: vi.fn(),
  } as unknown as PluginContext;
  return { ctx, rpcs, exec, spawn };
}

describe('device actions', () => {
  it('boots an Android AVD through the process gateway', async () => {
    const { ctx, rpcs, spawn } = setupActions();
    await plugin.setup(ctx);
    const result = await rpcs.get('devices.boot')!.handler({ id: 'Pixel_9', platform: 'android' });
    expect(result).toEqual({ ok: true, message: 'Emulator starting (pid 99)' });
    expect(spawn).toHaveBeenCalledWith('emulator:Pixel_9', 'emulator', ['-avd', 'Pixel_9']);
  });

  it('shuts down, installs and runs Android apps via adb', async () => {
    const { ctx, rpcs, exec } = setupActions();
    await plugin.setup(ctx);

    await rpcs.get('devices.shutdown')!.handler({ id: 'emulator-5554', platform: 'android' });
    await rpcs.get('devices.installApp')!.handler({ id: 'emulator-5554', platform: 'android', path: '/tmp/app.apk' });
    await rpcs.get('devices.runApp')!.handler({ id: 'emulator-5554', platform: 'android', app: 'com.example' });

    expect(exec).toHaveBeenNthCalledWith(1, 'adb', ['-s', 'emulator-5554', 'emu', 'kill']);
    expect(exec).toHaveBeenNthCalledWith(2, 'adb', ['-s', 'emulator-5554', 'install', '-r', '/tmp/app.apk']);
    expect(exec).toHaveBeenNthCalledWith(3, 'adb', [
      '-s', 'emulator-5554', 'shell', 'monkey', '-p', 'com.example',
      '-c', 'android.intent.category.LAUNCHER', '1',
    ]);
  });

  it('reports failures from the process gateway', async () => {
    const { ctx, rpcs, exec } = setupActions();
    exec.mockResolvedValueOnce({ stdout: '', stderr: 'error: device offline', exitCode: 1 });
    await plugin.setup(ctx);
    const result = await rpcs.get('devices.shutdown')!.handler({ id: 'offline', platform: 'android' });
    expect(result).toEqual({ ok: false, message: 'error: device offline' });
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
      registerRpc: (name: string, method: RpcMethod) => { if (name === 'devices.list') rpc = method; },
      registerCommand: vi.fn(),
    } as unknown as PluginContext;

    await plugin.setup(ctx);
    expect(rpc).toBeDefined();
    const result = await rpc!.handler({});
    expect(result).toHaveProperty('devices');
    expect(Array.isArray((result as { devices: unknown[] }).devices)).toBe(true);
  });
});
