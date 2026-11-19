import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext, RpcMethod } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin, { parseAndroidApps, parseIosApps } from './index.js';

describe('app parsers', () => {
  it('extracts iOS bundle ids and Android packages', () => {
    expect(parseIosApps([
      '\tCFBundleIdentifier = "com.apple.SpringBoard";',
      '\tCFBundleIdentifier = "com.example.app";',
    ].join('\n'))).toEqual(['com.example.app']);
    expect(parseAndroidApps('package:com.example.app\npackage:com.other\n')).toEqual([
      'com.example.app', 'com.other',
    ]);
  });
});

describe('plugin-storage', () => {
  it('reads the legacy AsyncStorage manifest from an iOS container', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-storage-test-'));
    try {
      const manifestDir = join(root, 'Library', 'Application Support', 'com.example.app', 'RCTAsyncLocalStorage_V1');
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(join(manifestDir, 'manifest.json'), JSON.stringify({ token: 'abc', theme: 'dark' }));

      const rpcs = new Map<string, RpcMethod>();
      const exec = vi.fn(async (command: string) => {
        if (command === 'xcrun') return { stdout: `${root}\n`, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const ctx = {
        bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        processes: { spawn: vi.fn(), exec, stop: vi.fn(), write: vi.fn(), isRunning: vi.fn() },
        registerRpc: (name: string, method: RpcMethod) => { rpcs.set(name, method); },
        registerCommand: vi.fn(),
      } as unknown as PluginContext;

      await plugin.setup(ctx);
      const sources = await rpcs.get('storage.sources')!.handler({ app: 'com.example.app', platform: 'ios' }) as {
        sources: Array<{ kind: string; path: string; available: boolean }>;
      };
      const manifest = sources.sources.find((source) => source.kind === 'asyncstorage-json');
      expect(manifest?.available).toBe(true);

      const result = await rpcs.get('storage.read')!.handler({
        app: 'com.example.app',
        platform: 'ios',
        source: manifest!.path,
        kind: 'asyncstorage-json',
        limit: 10,
      }) as { entries: Array<{ key: string; value: string }> };
      expect(result.entries).toEqual([
        { key: 'token', value: 'abc' },
        { key: 'theme', value: 'dark' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a confirmed key to an iOS AsyncStorage manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-storage-write-'));
    try {
      const path = join(root, 'manifest.json');
      writeFileSync(path, JSON.stringify({ existing: 'yes' }));
      const rpcs = new Map<string, RpcMethod>();
      const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
      const ctx = {
        bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        processes: { spawn: vi.fn(), exec, stop: vi.fn(), write: vi.fn(), isRunning: vi.fn() },
        registerRpc: (name: string, method: RpcMethod) => { rpcs.set(name, method); },
        registerCommand: vi.fn(),
      } as unknown as PluginContext;
      await plugin.setup(ctx);

      const result = await rpcs.get('storage.write')!.handler({
        app: 'com.example.app', platform: 'ios', source: path, kind: 'asyncstorage-json',
        key: 'token', value: 'abc', confirm: true,
      }) as { written: boolean };
      expect(result.written).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ existing: 'yes', token: 'abc' });
      expect(exec).toHaveBeenCalledWith('xcrun', ['simctl', 'terminate', 'booted', 'com.example.app']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports MMKV and full clear as unavailable', async () => {
    const rpcs = new Map<string, RpcMethod>();
    const ctx = {
      bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processes: { spawn: vi.fn(), exec: vi.fn(), stop: vi.fn(), write: vi.fn(), isRunning: vi.fn() },
      registerRpc: (name: string, method: RpcMethod) => { rpcs.set(name, method); },
      registerCommand: vi.fn(),
    } as unknown as PluginContext;
    await plugin.setup(ctx);
    expect(await rpcs.get('storage.write')!.handler({
      app: 'a', platform: 'ios', source: 's', kind: 'asyncstorage-json', key: 'k', value: 'v', confirm: false,
    })).toMatchObject({ written: false, reason: expect.stringContaining('Confirmation') });
    const read = await rpcs.get('storage.read')!.handler({
      app: 'a', platform: 'ios', source: 's', kind: 'mmkv', limit: 10,
    }) as { available: boolean };
    expect(read.available).toBe(false);
  });
});
