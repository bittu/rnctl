import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { daemonMessageSchema, type EventListener } from '@rnctl/sdk';
import WebSocket from 'ws';

/** Reads the port written by the daemon at startup. */
export function readDaemonPort(): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), '.rnctl', 'daemon.json'), 'utf8')) as { port?: number };
    return typeof parsed.port === 'number' ? parsed.port : undefined;
  } catch {
    return undefined;
  }
}

export class RpcClient {
  private sequence = 0;
  private readonly pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly listeners = new Map<string, Set<EventListener<unknown>>>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = daemonMessageSchema.parse(JSON.parse(raw.toString()));
      if (message.type === 'event') {
        for (const listener of this.listeners.get(message.topic) ?? []) listener(message.payload);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.type === 'rpc-error') pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect(port = readDaemonPort()): Promise<RpcClient> {
    if (port === undefined) throw new Error('No rnctl daemon found. Start one with `rnctl` first.');
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new RpcClient(socket);
  }

  call<T>(method: string, params: unknown = {}): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket.send(JSON.stringify({ type: 'rpc', id, method, params }));
    });
  }

  on<T>(topic: string, listener: EventListener<T>): () => void {
    const set = this.listeners.get(topic) ?? new Set<EventListener<unknown>>();
    set.add(listener as EventListener<unknown>);
    this.listeners.set(topic, set);
    return () => { set.delete(listener as EventListener<unknown>); };
  }

  close(): void {
    this.socket.close();
  }
}
