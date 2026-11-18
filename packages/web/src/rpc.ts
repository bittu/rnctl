export interface Device {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  state: 'booted' | 'shutdown' | 'unknown';
}

interface DaemonMessage {
  type: 'rpc-result' | 'rpc-error' | 'event';
  id?: number;
  result?: unknown;
  error?: { message: string };
}

export class WebRpcClient {
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as DaemonMessage;
      if (message.type === 'event' || message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.type === 'rpc-error') pending.reject(new Error(message.error?.message ?? 'RPC error'));
      else pending.resolve(message.result);
    };
  }

  static async connect(): Promise<WebRpcClient> {
    const response = await fetch('/api/daemon');
    if (!response.ok) throw new Error('Dashboard cannot reach the rnctl daemon');
    const { port } = await response.json() as { port: number };
    const socket = new WebSocket(`ws://${window.location.hostname}:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Could not connect to the rnctl daemon'));
    });
    return new WebRpcClient(socket);
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

  close(): void {
    this.socket.close();
  }
}
