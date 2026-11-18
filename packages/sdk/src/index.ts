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

export interface EventBus {
  on<T>(topic: string, listener: EventListener<T>): () => void;
  off<T>(topic: string, listener: EventListener<T>): void;
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
}

/** Process gateway for plugins; plugins must never import node:child_process. */
export interface Processes {
  spawn(id: string, command: string, args?: string[], options?: SpawnOptions): Promise<ProcessHandle>;
  exec(command: string, args?: string[], options?: SpawnOptions): Promise<ExecResult>;
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
