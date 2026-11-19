import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('reports write and MMKV as unavailable', async () => {
    const rpcs = new Map<string, RpcMethod>();
    const ctx = {
      bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processes: { spawn: vi.fn(), exec: vi.fn(), stop: vi.fn(), write: vi.fn(), isRunning: vi.fn() },
      registerRpc: (name: string, method: RpcMethod) => { rpcs.set(name, method); },
      registerCommand: vi.fn(),
    } as unknown as PluginContext;
    await plugin.setup(ctx);
    expect(await rpcs.get('storage.write')!.handler({ app: 'a', source: 's' })).toMatchObject({ available: false });
    const read = await rpcs.get('storage.read')!.handler({
      app: 'a', platform: 'ios', source: 's', kind: 'mmkv', limit: 10,
    }) as { available: boolean };
    expect(read.available).toBe(false);
  });
});
