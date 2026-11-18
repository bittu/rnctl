import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext, RpcMethod } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin, { type DoctorCheck } from './index.js';

describe('plugin-doctor', () => {
  it('reports real environment probe results', async () => {
    let rpc: RpcMethod | undefined;
    const exec = vi.fn(async (command: string) => {
      if (command === process.execPath) return { stdout: 'v24.22.1\n', stderr: '', exitCode: 0 };
      if (command === 'java') return { stdout: '', stderr: 'openjdk version "21"\n', exitCode: 0 };
      if (command === 'adb') return { stdout: 'Android Debug Bridge\n', stderr: '', exitCode: 0 };
      if (command === 'lsof') return { stdout: '', stderr: '', exitCode: 1 };
      throw new Error('not installed');
    });
    const ctx = {
      bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processes: { spawn: vi.fn(), exec, stop: vi.fn(), write: vi.fn() },
      registerRpc: (name: string, method: RpcMethod) => { if (name === 'doctor.check') rpc = method; },
      registerCommand: vi.fn(),
    } as unknown as PluginContext;

    await plugin.setup(ctx);
    const result = await rpc!.handler({}) as { healthy: boolean; checks: DoctorCheck[] };
    const byName = new Map(result.checks.map((check) => [check.name, check]));

    expect(byName.get('node')?.ok).toBe(true);
    expect(byName.get('java')?.detail).toContain('openjdk');
    expect(byName.get('adb')?.ok).toBe(true);
    expect(byName.get('watchman')?.ok).toBe(false);
    expect(byName.get('port 8081')?.ok).toBe(true);
    expect(result.healthy).toBe(false);
  });

  it('reads project metadata and scripts from package.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-project-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'demo-app',
        dependencies: { 'react-native': '0.80.0' },
        scripts: { ios: 'react-native run-ios', android: 'react-native run-android' },
      }));

      let rpc: RpcMethod | undefined;
      const ctx = {
        bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        processes: { spawn: vi.fn(), exec: vi.fn(), stop: vi.fn(), write: vi.fn() },
        registerRpc: (name: string, method: RpcMethod) => { if (name === 'project.info') rpc = method; },
        registerCommand: vi.fn(),
      } as unknown as PluginContext;

      await plugin.setup(ctx);
      const result = await rpc!.handler({ cwd: root }) as {
        name: string;
        isReactNative: boolean;
        scripts: Array<{ name: string; command: string }>;
      };
      expect(result.name).toBe('demo-app');
      expect(result.isReactNative).toBe(true);
      expect(result.scripts.map((script) => script.name)).toEqual(['ios', 'android']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
