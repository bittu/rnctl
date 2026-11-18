import { z } from 'zod';

export { z };

export type Platform = 'ios' | 'android';
export type DeviceState = 'booted' | 'shutdown' | 'unknown';

export interface DeviceInfo {
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

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type EventListener<T = unknown> = (payload: T) => void;

export type AnyEventListener = (topic: string, payload: unknown) => void;

export interface EventBus {
  on<T>(topic: string, listener: EventListener<T>): () => void;
  off<T>(topic: string, listener: EventListener<T>): void;
  onAny(listener: AnyEventListener): () => void;
  emit<T>(topic: string, payload: T): Promise<void>;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProcessHandle {
  id: string;
  pid?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Payload of the `process:stdout` and `process:stderr` events. */
export interface ProcessOutput {
  id: string;
  chunk: string;
}

/** Payload of the `process:exit` event. */
export interface ProcessExit {
  id: string;
  code: number | null;
  signal: string | null;
}

/** Process gateway for plugins; plugins must never import node:child_process. */
export interface Processes {
  spawn(id: string, command: string, args?: string[], options?: SpawnOptions): Promise<ProcessHandle>;
  exec(command: string, args?: string[], options?: SpawnOptions): Promise<ExecResult>;
  stop(id: string, signal?: string): Promise<void>;
}

export interface RpcMethod<TInput = unknown, TOutput = unknown> {
  inputSchema: z.ZodType<TInput>;
  handler: (input: TInput) => Promise<TOutput>;
}

export interface CommandDefinition {
  name: string;
  description: string;
  action: (args: string[], ctx: PluginContext) => Promise<void>;
}

export interface PluginContext {
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly processes: Processes;
  registerRpc<TInput, TOutput>(method: string, definition: RpcMethod<TInput, TOutput>): void;
  registerCommand(command: CommandDefinition): void;
}

export interface RnctlPlugin {
  name: string;
  version: string;
  description: string;
  setup(ctx: PluginContext): Promise<void>;
  teardown?(ctx: PluginContext): Promise<void>;
}

export function definePlugin(plugin: RnctlPlugin): RnctlPlugin {
  return plugin;
}

const rpcIdSchema = z.union([z.string(), z.number()]);

export const rpcRequestSchema = z.object({
  type: z.literal('rpc'),
  id: rpcIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

export const daemonMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rpc-result'), id: rpcIdSchema, result: z.unknown() }),
  z.object({
    type: z.literal('rpc-error'),
    id: rpcIdSchema,
    error: z.object({ code: z.number(), message: z.string() }),
  }),
  z.object({ type: z.literal('event'), topic: z.string(), payload: z.unknown() }),
]);
export type DaemonMessage = z.infer<typeof daemonMessageSchema>;
