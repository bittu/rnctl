import type { PluginContext, RpcMethod } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin, { parseGfxInfo, parseLogcatCrashes } from './index.js';

describe('perf parsers', () => {
  it('splits logcat crash blocks and finds Hermes frames', () => {
    const log = [
      '--------- beginning of crash',
      'E AndroidRuntime: com.facebook.react.common.JavascriptException: Boom, js engine: hermes, stack:',
      'E AndroidRuntime:  at foo@1:132161',
      'E AndroidRuntime:  at bar@1:120',
      '',
      'E AndroidRuntime: FATAL EXCEPTION: main',
      'E AndroidRuntime: java.lang.RuntimeException: native crash',
    ].join('\n');
    const crashes = parseLogcatCrashes(log, 'com.example');
    expect(crashes).toHaveLength(2);
    expect(crashes[0].kind).toBe('js');
    expect(crashes[0].frames).toContain('E AndroidRuntime:  at foo@1:132161');
    expect(crashes[1].kind).toBe('native');
  });

  it('parses gfxinfo percentile metrics', () => {
    const output = [
      'Janky frames: 12 (10.00%)',
      '90th percentile: 18ms',
      '95th percentile: 24ms',
    ].join('\n');
    expect(parseGfxInfo(output)).toEqual({ jankyPct: 10, p90Ms: 18, p95Ms: 24 });
  });
});

describe('plugin-perf', () => {
  function setup() {
    const rpcs = new Map<string, RpcMethod>();
    const emitted: Array<{ topic: string; payload: unknown }> = [];
    const exec = vi.fn(async () => ({
      stdout: 'Janky frames: 10 (10.00%)\n95th percentile: 20ms\n',
      stderr: '',
      exitCode: 0,
    }));
    const ctx = {
      bus: {
        on: vi.fn(), off: vi.fn(), onAny: vi.fn(),
        emit: async (topic: string, payload: unknown) => { emitted.push({ topic, payload }); },
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processes: { spawn: vi.fn(), exec, stop: vi.fn(), write: vi.fn(), isRunning: vi.fn() },
      registerRpc: (name: string, method: RpcMethod) => { rpcs.set(name, method); },
      registerCommand: vi.fn(),
    } as unknown as PluginContext;
    return { ctx, rpcs, emitted, exec };
  }

  it('reports a missing source map without invoking symbolication', async () => {
    const { ctx, rpcs } = setup();
    await plugin.setup(ctx);
    const result = await rpcs.get('perf.symbolicate')!.handler({
      sourcemap: '/definitely/missing.map',
      stack: 'at foo@1:2',
    }) as { available: boolean };
    expect(result.available).toBe(false);
  });

  it('samples frame metrics and emits events', async () => {
    const { ctx, rpcs, emitted } = setup();
    await plugin.setup(ctx);
    expect(await rpcs.get('perf.fpsStart')!.handler({ app: 'com.example', intervalMs: 60000 }))
      .toMatchObject({ started: true });
    const result = await rpcs.get('perf.fpsSamples')!.handler({ limit: 10 }) as {
      samples: Array<{ app: string; jankyPct?: number; uiFps?: number }>;
    };
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].app).toBe('com.example');
    expect(result.samples[0].jankyPct).toBe(10);
    expect(emitted.some((event) => event.topic === 'perf:fps-sample')).toBe(true);
    expect(await rpcs.get('perf.fpsStop')!.handler({})).toEqual({ stopped: true });
  });
});
