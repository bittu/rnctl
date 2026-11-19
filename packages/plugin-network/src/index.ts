import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { definePlugin, z, type PluginContext } from '@rnctl/sdk';

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

interface CdpTarget {
  id: string;
  webSocketDebuggerUrl?: string;
}

interface RequestPayload {
  url: string;
  method: string;
  headers?: Record<string, string>;
}

interface ResponsePayload {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
}

interface PageTarget {
  webSocketDebuggerUrl: string;
  id?: string;
}

/** React Native's first-party CDP Network backend landed in 0.83. */
export function isSupportedVersion(version: string | undefined): boolean {
  if (!version) return false;
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > 0 || (major === 0 && minor >= 83);
}

function installedVersion(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'node_modules', 'react-native', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export default definePlugin({
  name: '@rnctl/plugin-network',
  version: '0.1.0',
  description: 'Zero-SDK network request inspection via Metro CDP',
  async setup(ctx: PluginContext) {
    // shortcut: WebSocket frame inspection is not supported by RN 0.83's Network domain.
    const MAX_ENTRIES = 500;
    const entries: NetworkEntry[] = [];
    const pending = new Map<string, { entry: NetworkEntry; started: number }>();
    const bodies = new Map<number, { resolve: (value: unknown) => void }>();
    let socket: WebSocket | undefined;
    let commandId = 0;
    let entryId = 0;
    let targetId: string | undefined;

    const push = (entry: NetworkEntry): void => {
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries.shift();
      void ctx.bus.emit('network:request', entry);
    };

    const command = (method: string, params: Record<string, unknown> = {}): number => {
      const id = ++commandId;
      socket?.send(JSON.stringify({ id, method, params }));
      return id;
    };

    const onMessage = (raw: string): void => {
      let message: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
      };
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        return;
      }
      if (message.id !== undefined && bodies.has(message.id)) {
        bodies.get(message.id)!.resolve(message.result);
        bodies.delete(message.id);
        return;
      }
      const params = message.params ?? {};
      if (message.method === 'Network.requestWillBeSent') {
        const request = params.request as RequestPayload | undefined;
        const requestId = String(params.requestId ?? '');
        if (!request || !requestId) return;
        const entry: NetworkEntry = {
          id: String(++entryId),
          timestamp: Date.now(),
          requestId,
          method: request.method,
          url: request.url,
          requestHeaders: request.headers ?? {},
          responseHeaders: {},
        };
        pending.set(requestId, { entry, started: Number(params.timestamp ?? Date.now() / 1000) });
      } else if (message.method === 'Network.responseReceived' && params.response) {
        const requestId = String(params.requestId ?? '');
        const record = pending.get(requestId);
        const response = params.response as ResponsePayload;
        if (!record) return;
        record.entry.status = response.status;
        record.entry.statusText = response.statusText;
        record.entry.responseHeaders = response.headers ?? {};
        record.entry.resourceType = String(params.type ?? '') || undefined;
      } else if (message.method === 'Network.loadingFinished') {
        const record = pending.get(String(params.requestId ?? ''));
        if (!record) return;
        const finished = Number(params.timestamp ?? Date.now() / 1000);
        record.entry.durationMs = Math.round((finished - record.started) * 1000);
        push(record.entry);
        pending.delete(record.entry.requestId);
      } else if (message.method === 'Network.loadingFailed') {
        const record = pending.get(String(params.requestId ?? ''));
        if (!record) return;
        record.entry.errorText = String(params.errorText ?? 'failed');
        record.entry.durationMs = Math.round((Number(params.timestamp ?? 0) - record.started) * 1000);
        push(record.entry);
        pending.delete(record.entry.requestId);
      }
    };

    ctx.registerRpc('network.status', {
      inputSchema: z.object({ port: z.number().int().positive().default(8081) }),
      handler: async ({ port }) => {
        const version = installedVersion(process.cwd());
        if (!isSupportedVersion(version)) {
          return { available: false, reason: 'Requires a React Native 0.83+ dev build', targets: 0, attached: Boolean(socket) };
        }
        let targets: CdpTarget[] = [];
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json`);
          targets = await response.json() as CdpTarget[];
        } catch {
          return { available: false, reason: 'Metro inspector is not reachable', targets: 0, attached: Boolean(socket) };
        }
        return { available: targets.length > 0, targets: targets.length, attached: Boolean(socket) };
      },
    });

    ctx.registerRpc('network.attach', {
      inputSchema: z.object({ port: z.number().int().positive().default(8081) }),
      handler: async ({ port }) => {
        if (socket) return { attached: true, target: targetId, message: 'Already attached' };
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json`);
          const targets = await response.json() as PageTarget[];
          const target = targets.find((candidate) => candidate.webSocketDebuggerUrl);
          if (!target) return { attached: false, message: 'No debug target is connected to Metro' };

          socket = new WebSocket(target.webSocketDebuggerUrl);
          socket.onmessage = (event: MessageEvent<string>) => onMessage(String(event.data));
          await new Promise<void>((resolve, reject) => {
            socket!.onopen = () => resolve();
            socket!.onerror = () => reject(new Error('Could not connect to the CDP target'));
          });
          command('Network.enable', { maxTotalBufferSize: 10485760, maxPostDataSize: 65536 });
          targetId = target.id;
          ctx.bus.emit('network:attached', { targetId });
          return { attached: true, target: targetId, message: 'Network inspector attached' };
        } catch (error) {
          socket = undefined;
          return { attached: false, message: String(error) };
        }
      },
    });

    ctx.registerRpc('network.detach', {
      inputSchema: z.object({}),
      handler: async () => {
        if (!socket) return { detached: false };
        command('Network.disable');
        socket.close();
        socket = undefined;
        targetId = undefined;
        return { detached: true };
      },
    });

    ctx.registerRpc('network.list', {
      inputSchema: z.object({
        limit: z.number().int().positive().default(100),
        method: z.string().optional(),
      }),
      handler: async ({ limit, method }) => ({
        entries: entries
          .filter((entry) => !method || entry.method === method)
          .slice(-limit),
      }),
    });

    ctx.registerRpc('network.clear', {
      inputSchema: z.object({}),
      handler: async () => {
        entries.length = 0;
        return { cleared: true };
      },
    });

    ctx.registerRpc('network.body', {
      inputSchema: z.object({ requestId: z.string() }),
      handler: async ({ requestId }) => {
        if (!socket) return { available: false };
        const id = command('Network.getResponseBody', { requestId });
        const body = await new Promise<{ body?: string; base64Encoded?: boolean }>((resolve) => {
          bodies.set(id, { resolve: (value) => resolve(value as { body?: string; base64Encoded?: boolean }) });
          setTimeout(() => {
            if (bodies.delete(id)) resolve({});
          }, 3000);
        });
        return { available: true, ...body };
      },
    });
  },
});
