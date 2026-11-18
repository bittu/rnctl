import type { CommandDefinition, Logger, PluginContext, RpcMethod } from '@rnctl/sdk';
import { TypedEventBus } from './event-bus.js';
import { PluginLoader } from './plugin-loader.js';
import { ProcessSupervisor } from './process-supervisor.js';
import { startRpcServer, type RpcServer } from './rpc-server.js';

export { TypedEventBus } from './event-bus.js';
export { PluginLoader } from './plugin-loader.js';
export { ProcessSupervisor } from './process-supervisor.js';
export { RpcClient, readDaemonPort } from './rpc-client.js';
export { startRpcServer } from './rpc-server.js';

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
  port(): number | undefined;
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
  let server: RpcServer | undefined;

  return {
    ctx,
    loader,
    commands: () => [...commands.values()] as CommandDefinition[],
    rpcMethods: () => rpcMethods as ReadonlyMap<string, RpcMethod>,
    port: () => server?.port,
    async start() {
      server = await startRpcServer(bus, rpcMethods as ReadonlyMap<string, RpcMethod>);
    },
    async stop() {
      await loader.unloadAll();
      await server?.stop();
      await processes.shutdown();
    },
  };
}
