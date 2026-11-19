import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext, RpcMethod } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin, { isSupportedVersion } from './index.js';

describe('version gate', () => {
  it('requires React Native 0.83 or newer', () => {
    expect(isSupportedVersion('0.82.1')).toBe(false);
    expect(isSupportedVersion('0.83.0')).toBe(true);
    expect(isSupportedVersion('0.84.0-rc.1')).toBe(true);
    expect(isSupportedVersion(undefined)).toBe(false);
  });
});

describe('plugin-network', () => {
  it('reports unavailability outside a supported RN project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-network-'));
    let rpc: RpcMethod | undefined;
    const ctx = {
      bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processes: { spawn: vi.fn(), exec: vi.fn(), stop: vi.fn(), write: vi.fn(), isRunning: vi.fn() },
      registerRpc: (name: string, method: RpcMethod) => { if (name === 'network.status') rpc = method; },
      registerCommand: vi.fn(),
    } as unknown as PluginContext;

    await plugin.setup(ctx);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const result = await rpc!.handler({ port: 8081 }) as { available: boolean; reason?: string };
      expect(result.available).toBe(false);
      expect(result.reason).toContain('0.83');
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
