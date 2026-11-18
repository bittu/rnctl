import type { CommandDefinition, Logger, PluginContext, RpcMethod } from '@rnctl/sdk';
import { TypedEventBus } from './event-bus.js';
import { PluginLoader } from './plugin-loader.js';
import { ProcessSupervisor } from './process-supervisor.js';

export { TypedEventBus, PluginLoader, ProcessSupervisor };

const defaultLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export interface Daemon {
  readonly ctx: PluginContext;
  readonly loader: PluginLoader;
  commands(): readonly CommandDefinition[];
  rpcMethods(): ReadonlyMap<string, RpcMethod>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDaemon(logger: Logger = defaultLogger): Daemon {
  const bus = new TypedEventBus();
  const processes = new ProcessSupervisor((topic, payload) => { void bus.emit(topic, payload); });
  const rpcMethods = new Map<string, unknown>();
  const commands = new Map<string, unknown>();

  const ctx: PluginContext = {
    bus,
    logger,
    processes,
    registerRpc: (method, definition) => { rpcMethods.set(method, definition); },
    registerCommand: (command) => { commands.set(command.name, command); },
  };

  const loader = new PluginLoader(ctx);

  return {
    ctx,
    loader,
    commands: () => [...commands.values()] as CommandDefinition[],
    rpcMethods: () => rpcMethods as ReadonlyMap<string, RpcMethod>,
    // shortcut: IPC/WebSocket transport is not wired yet; RPC methods are in-process.
    async start() {},
    async stop() {
      await loader.unloadAll();
      await processes.shutdown();
    },
  };
}
