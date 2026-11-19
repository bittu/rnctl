import type { PluginContext, RpcMethod } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createToolRunner, redactNetworkResult, TOOLS } from './tools.js';

describe('MCP tool bridge', () => {
  it('bridges a registered RPC with validated input', async () => {
    const handler = vi.fn(async (input: { limit: number }) => ({ entries: Array(input.limit).fill('x') }));
    const getRpc = vi.fn((method: string) => method === 'logs.list'
      ? { inputSchema: TOOLS.find((tool) => tool.name === 'rnctl_logs_list')!.inputSchema, handler } as unknown as RpcMethod
      : undefined);
    const run = createToolRunner({ getRpc } as Pick<PluginContext, 'getRpc'>);

    const result = await run('rnctl_logs_list', { limit: 2 });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ entries: ['x', 'x'] });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
  });

  it('exposes the second-wave tool namespaces', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'rnctl_broadcast_reload', 'rnctl_broadcast_deep_link', 'rnctl_broadcast_dark_mode',
      'rnctl_network_status', 'rnctl_network_list',
      'rnctl_storage_apps', 'rnctl_storage_sources', 'rnctl_storage_read',
      'rnctl_perf_crashes', 'rnctl_perf_fps_samples',
    ]));
    expect(TOOLS.find((tool) => tool.name === 'rnctl_broadcast_reload')?.readOnly).toBe(false);
    expect(TOOLS.find((tool) => tool.name === 'rnctl_network_list')?.readOnly).toBe(true);
  });

  it('strips credential headers from network results', () => {
    const input = JSON.stringify({
      entries: [{
        url: 'https://example.com/api',
        requestHeaders: { Authorization: 'Bearer secret', Accept: 'application/json' },
        responseHeaders: { 'Set-Cookie': 'session=abc', 'Content-Type': 'application/json' },
      }],
    });
    const output = JSON.parse(redactNetworkResult(input)) as {
      entries: Array<{ requestHeaders: Record<string, string>; responseHeaders: Record<string, string> }>;
    };
    expect(output.entries[0].requestHeaders).toEqual({ Accept: 'application/json' });
    expect(output.entries[0].responseHeaders).toEqual({ 'Content-Type': 'application/json' });
  });

  it('calls through a connected daemon client', async () => {
    const call = vi.fn(async () => ({ devices: [] }));
    const run = createToolRunner({ call });
    const result = await run('rnctl_device_list', {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ devices: [] });
    expect(call).toHaveBeenCalledWith('devices.list', {});
  });

  it('reports unknown tools, missing RPCs and invalid input', async () => {
    const run = createToolRunner({ getRpc: () => undefined } as Pick<PluginContext, 'getRpc'>);
    expect((await run('rnctl_unknown', {})).isError).toBe(true);
    expect((await run('rnctl_device_list', {})).text).toContain('unavailable');

    const handler = vi.fn(async () => ({}));
    const withRpc = createToolRunner({
      getRpc: () => ({ inputSchema: TOOLS.find((tool) => tool.name === 'rnctl_logs_list')!.inputSchema, handler }) as unknown as RpcMethod,
    } as Pick<PluginContext, 'getRpc'>);
    const result = await withRpc('rnctl_logs_list', { limit: -1 });
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});
