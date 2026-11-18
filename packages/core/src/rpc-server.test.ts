import type { RpcMethod } from '@rnctl/sdk';
import { z } from '@rnctl/sdk';
import { describe, expect, it } from 'vitest';
import { TypedEventBus } from './event-bus.js';
import { RpcClient } from './rpc-client.js';
import { startRpcServer } from './rpc-server.js';

describe('RPC transport', () => {
  it('calls registered methods and forwards bus events', async () => {
    const bus = new TypedEventBus();
    const methods = new Map<string, RpcMethod>([
      ['test.ping', {
        inputSchema: z.object({ echo: z.string() }),
        handler: async ({ echo }) => ({ reply: echo }),
      } as RpcMethod],
    ]);
    const server = await startRpcServer(bus, methods);
    const client = await RpcClient.connect(server.port);

    try {
      const result = await client.call<{ reply: string }>('test.ping', { echo: 'hi' });
      expect(result.reply).toBe('hi');

      const received = new Promise<unknown>((resolve) => { client.on('device:booted', resolve); });
      await bus.emit('device:booted', { id: 'device-1' });
      const payload = await Promise.race([
        received,
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      expect(payload).toEqual({ id: 'device-1' });

      await expect(client.call('test.unknown', {})).rejects.toThrow(/Unknown RPC method/);
    } finally {
      client.close();
      await server.stop();
    }
  });
});
