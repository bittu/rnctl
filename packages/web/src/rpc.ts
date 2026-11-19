/** Shared wire types and the browser-side JSON-RPC / event client. */

export type Platform = 'ios' | 'android';
export type DeviceState = 'booted' | 'shutdown' | 'unknown';

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  state: DeviceState;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: number;
  source: string;
  level: LogLevel;
  message: string;
}

export interface LogSource {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
}

export interface ProjectInfo {
  name: string;
  isReactNative: boolean;
  scripts: Array<{ name: string; command: string }>;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface NukeTarget {
  id: string;
  label: string;
  paths: string[];
  command?: { executable: string; args: string[] };
  sizeBytes: number;
}

export interface NukePreview {
  removals: Array<{ id: string; path: string; sizeBytes: number }>;
  commands: string[];
  totalBytes: number;
}

export interface NukeResult {
  removed: string[];
  reclaimedBytes: number;
  errors: string[];
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface BroadcastItem {
  id: string;
  platform: string;
  ok: boolean;
  message: string;
}

export interface BroadcastResult {
  results: BroadcastItem[];
  sent: number;
}

export interface NetworkEntry {
  id: string;
  timestamp: number;
  requestId: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  durationMs?: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  errorText?: string;
}

export interface NetworkStatus {
  available: boolean;
  reason?: string;
  targets: number;
  attached: boolean;
}

export interface StorageApp {
  id: string;
  platform: Platform;
}

export type StorageKind = 'asyncstorage-json' | 'asyncstorage-sqlite' | 'sqlite' | 'mmkv';

export interface StorageSource {
  id: string;
  kind: StorageKind;
  path: string;
  available: boolean;
  reason?: string;
}

export interface StorageEntry {
  key: string;
  value: string;
}

export interface PerfCrash {
  id: string;
  platform: Platform;
  app: string;
  timestamp: number;
  kind: 'js' | 'native';
  source: string;
  excerpt: string;
  frames: string[];
}

export interface FpsSample {
  id: string;
  timestamp: number;
  platform: 'android';
  app: string;
  uiFps?: number;
  jankyPct?: number;
  p90Ms?: number;
  p95Ms?: number;
}

export interface ProcessExit {
  id: string;
  code: number | null;
  signal: string | null;
}

type EventListener<T> = (payload: T) => void;

interface DaemonMessage {
  type: 'rpc-result' | 'rpc-error' | 'event';
  id?: number;
  result?: unknown;
  error?: { message: string };
  topic?: string;
  payload?: unknown;
}

/** Connects to the local daemon and exposes RPC calls plus topic subscriptions. */
export class WebRpcClient {
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly listeners = new Map<string, Set<EventListener<unknown>>>();

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: DaemonMessage;
      try {
        message = JSON.parse(event.data) as DaemonMessage;
      } catch {
        return;
      }
      if (message.type === 'event') {
        if (!message.topic) return;
        for (const listener of this.listeners.get(message.topic) ?? []) listener(message.payload);
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.type === 'rpc-error') pending.reject(new Error(message.error?.message ?? 'RPC error'));
      else pending.resolve(message.result);
    };
    socket.onclose = () => {
      const error = new Error('Daemon connection closed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
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

  /** Subscribe to a daemon event topic. Returns an unsubscribe function. */
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
