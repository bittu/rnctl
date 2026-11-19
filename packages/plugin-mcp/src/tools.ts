import { z, type PluginContext, type RpcMethod } from '@rnctl/sdk';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  rpc: string;
  readOnly: boolean;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'rnctl_project_info',
    description: 'Current project name, React Native detection and package.json scripts',
    inputSchema: z.object({ cwd: z.string().optional() }),
    rpc: 'project.info',
    readOnly: true,
  },
  {
    name: 'rnctl_device_list',
    description: 'List iOS simulators and Android emulators with their state',
    inputSchema: z.object({}),
    rpc: 'devices.list',
    readOnly: true,
  },
  {
    name: 'rnctl_logs_sources',
    description: 'List available live log sources and why unavailable ones cannot be attached',
    inputSchema: z.object({}),
    rpc: 'logs.sources',
    readOnly: true,
  },
  {
    name: 'rnctl_logs_list',
    description: 'Read recent unified log entries, optionally filtered by level or session',
    inputSchema: z.object({
      level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      limit: z.number().int().positive().max(200).default(100),
      sessionId: z.string().optional(),
    }),
    rpc: 'logs.list',
    readOnly: true,
  },
  {
    name: 'rnctl_doctor_check',
    description: 'Check the React Native development environment',
    inputSchema: z.object({}),
    rpc: 'doctor.check',
    readOnly: true,
  },
  {
    name: 'rnctl_metro_start',
    description: 'Start Metro on the current project',
    inputSchema: z.object({ resetCache: z.boolean().default(false), cwd: z.string().optional() }),
    rpc: 'metro.start',
    readOnly: false,
  },
  {
    name: 'rnctl_metro_stop',
    description: 'Stop Metro',
    inputSchema: z.object({}),
    rpc: 'metro.stop',
    readOnly: false,
  },
  {
    name: 'rnctl_metro_reload',
    description: 'Reload JavaScript on the running app',
    inputSchema: z.object({}),
    rpc: 'metro.reload',
    readOnly: false,
  },
];

const MAX_TEXT = 20000;

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface RpcCaller {
  call(method: string, params: unknown): Promise<unknown>;
}

export type RpcSource = Pick<PluginContext, 'getRpc'> | RpcCaller;

/** Bridges MCP tool calls to either in-process RPCs or a connected daemon client. */
export function createToolRunner(source: RpcSource) {
  return async (name: string, args: unknown): Promise<ToolResult> => {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) return { text: `Unknown tool: ${name}`, isError: true };

    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) return { text: parsed.error.message, isError: true };

    const inProcess = 'getRpc' in source;
    if (!inProcess && typeof source.call !== 'function') {
      return { text: `RPC ${tool.rpc} is unavailable`, isError: true };
    }
    const rpc: RpcMethod | undefined = inProcess ? source.getRpc(tool.rpc) : undefined;
    if (inProcess && !rpc) return { text: `RPC ${tool.rpc} is unavailable`, isError: true };

    try {
      const result = inProcess
        ? await rpc!.handler(parsed.data)
        : await (source as RpcCaller).call(tool.rpc, parsed.data);
      let text = JSON.stringify(result);
      if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}… (truncated)`;
      return { text, isError: false };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
}
