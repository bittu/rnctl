import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rpcRequestSchema, type DaemonMessage, type EventBus, type RpcMethod } from '@rnctl/sdk';
import { WebSocket, WebSocketServer } from 'ws';

export interface RpcServer {
  readonly port: number;
  stop(): Promise<void>;
}

function send(socket: WebSocket, message: DaemonMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/** Exposes registered RPC methods and forwards bus events over a local WebSocket. */
export async function startRpcServer(bus: EventBus, methods: ReadonlyMap<string, RpcMethod>): Promise<RpcServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const offAny = bus.onAny((topic, payload) => {
    const message: DaemonMessage = { type: 'event', topic, payload };
    for (const socket of wss.clients) send(socket, message);
  });

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      void (async () => {
        let id: string | number = 'unknown';
        try {
          const request = rpcRequestSchema.parse(JSON.parse(raw.toString()));
          id = request.id;
          const method = methods.get(request.method);
          if (!method) throw new Error(`Unknown RPC method: ${request.method}`);
          const result = await method.handler(method.inputSchema.parse(request.params ?? {}));
          send(socket, { type: 'rpc-result', id, result });
        } catch (error) {
          send(socket, {
            type: 'rpc-error',
            id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          });
        }
      })();
    });
  });

  const dir = join(homedir(), '.rnctl');
  const portFile = join(dir, 'daemon.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(portFile, JSON.stringify({ port }));

  return {
    port,
    async stop() {
      offAny();
      for (const socket of wss.clients) socket.close();
      await new Promise<void>((resolve) => { wss.close(() => resolve()); });
      try { unlinkSync(portFile); } catch { /* already removed */ }
    },
  };
}
