import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { definePlugin, z, type PluginContext, type ProcessExit, type ProcessOutput } from '@rnctl/sdk';

export type Framework = 'maestro' | 'detox';

export interface E2eFlow {
  id: string;
  path: string;
  name: string;
  framework: Framework;
}

export interface E2eRun {
  runId: string;
  framework: Framework;
  flow: string;
  device: string;
  platform: 'ios' | 'android';
  configuration?: string;
  state: 'running' | 'passed' | 'failed' | 'error';
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  summary?: string;
  error?: string;
  artifactsDir: string;
  screenshots: string[];
}

const ROOTS: Record<Framework, string[]> = {
  maestro: ['.maestro', 'e2e', 'flows', 'maestro'],
  detox: ['e2e'],
};

/** Finds flow files under conventional project directories. */
export function discoverFlows(cwd: string, framework: Framework): E2eFlow[] {
  const flows: E2eFlow[] = [];
  for (const root of ROOTS[framework]) {
    const dir = join(cwd, root);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (framework === 'maestro' && !/\.ya?ml$/.test(entry)) continue;
      if (framework === 'maestro' && /(^|\/)(config\.ya?ml|subflows\/)/.test(entry)) continue;
      if (framework === 'detox' && !/\.(test|e2e|spec)\.[jt]sx?$/.test(entry)) continue;
      const path = join(dir, entry);
      flows.push({
        id: relative(cwd, path),
        path,
        name: entry.split('/').pop() ?? entry,
        framework,
      });
    }
  }
  return flows;
}

export function maestroArgs(flow: string, device: string, artifactsDir: string): string[] {
  return [
    '--device', device, 'test', '--no-ansi',
    '--test-output-dir', artifactsDir,
    '--format', 'junit', '--output', join(artifactsDir, 'report.xml'),
    flow,
  ];
}

export function detoxArgs(flow: string, configuration: string, artifactsDir: string): string[] {
  return [
    '--no-install', 'detox', 'test',
    '-C', 'e2e/config.json', '-c', configuration,
    '--no-color', '--take-screenshots', 'failing',
    '--artifacts-location', `${artifactsDir}/`,
    flow,
  ];
}

function findScreenshots(dir: string): string[] {
  try {
    return (readdirSync(dir, { recursive: true }) as string[])
      .filter((entry) => /\.(png|jpe?g)$/i.test(entry))
      .map((entry) => join(dir, entry));
  } catch {
    return [];
  }
}

let cleanup: (() => void) | undefined;

export default definePlugin({
  name: '@rnctl/plugin-e2e',
  version: '0.1.0',
  description: 'Maestro and Detox flow discovery and execution',
  async setup(ctx: PluginContext) {
    // shortcut: Detox uses a fixed e2e/config.json path; generated configs and app builds are not wired.
    const runs = new Map<string, E2eRun>();
    let runCounter = 0;

    const offs = [
      ctx.bus.on<ProcessExit>('process:exit', (event) => {
        if (!event.id.startsWith('e2e:')) return;
        const runId = event.id.slice(4);
        const run = runs.get(runId);
        if (!run || run.state !== 'running') return;
        run.exitCode = event.code ?? -1;
        run.state = event.code === 0 ? 'passed' : 'failed';
        run.finishedAt = Date.now();
        run.screenshots = findScreenshots(run.artifactsDir);
        void ctx.bus.emit('e2e:run-finished', run);
      }),
      ctx.bus.on<ProcessOutput>('process:stdout', (event) => {
        if (!event.id.startsWith('e2e:')) return;
        const run = runs.get(event.id.slice(4));
        if (run) run.summary = `${run.summary ?? ''}${event.chunk}`.slice(-2000);
      }),
    ];
    cleanup = () => { for (const off of offs) off(); };

    ctx.registerRpc('e2e.frameworks', {
      inputSchema: z.object({ cwd: z.string().optional() }),
      handler: async ({ cwd }) => {
        const dir = cwd ?? process.cwd();
        const frameworks = [];
        try {
          const result = await ctx.processes.exec('maestro', ['--version']);
          frameworks.push({
            id: 'maestro', available: result.exitCode === 0,
            version: (result.stdout || result.stderr).trim().split('\n')[0],
            installHint: 'curl -fsSL https://get.maestro.mobile.dev | bash (Java 17+)',
          });
        } catch {
          frameworks.push({
            id: 'maestro', available: false, reason: 'Maestro CLI not found',
            installHint: 'curl -fsSL https://get.maestro.mobile.dev | bash (Java 17+)',
          });
        }
        const detoxAvailable = existsSync(join(dir, 'node_modules', '.bin', 'detox'));
        frameworks.push({
          id: 'detox', available: detoxAvailable,
          reason: detoxAvailable ? undefined : 'Detox not installed in this project',
          installHint: 'pnpm add -D detox jest',
        });
        return { frameworks };
      },
    });

    ctx.registerRpc('e2e.flows', {
      inputSchema: z.object({
        cwd: z.string().optional(),
        framework: z.enum(['maestro', 'detox']),
      }),
      handler: async ({ cwd, framework }) => ({
        flows: discoverFlows(cwd ?? process.cwd(), framework),
        searchedDirs: ROOTS[framework],
      }),
    });

    ctx.registerRpc('e2e.run', {
      inputSchema: z.object({
        cwd: z.string().optional(),
        framework: z.enum(['maestro', 'detox']),
        flow: z.string(),
        device: z.string(),
        platform: z.enum(['ios', 'android']),
        configuration: z.string().default('ios.sim.debug'),
      }),
      handler: async ({ cwd, framework, flow, device, platform, configuration }) => {
        if (framework === 'detox' && platform === 'ios' && process.platform !== 'darwin') {
          return { runId: '', started: false, reason: 'iOS Detox runs require macOS' };
        }
        const runId = String(++runCounter);
        const processId = `e2e:${runId}`;
        const artifactsDir = mkdtempSync(join(process.cwd(), '.rnctl-e2e-'));
        const run: E2eRun = {
          runId, framework, flow, device, platform, configuration,
          state: 'running', startedAt: Date.now(), artifactsDir, screenshots: [],
        };
        runs.set(runId, run);

        const spawned = framework === 'maestro'
          ? { executable: 'maestro', args: maestroArgs(flow, device, artifactsDir) }
          : { executable: 'npx', args: detoxArgs(flow, configuration, artifactsDir) };

        try {
          await ctx.processes.spawn(processId, spawned.executable, spawned.args, { cwd });
          void ctx.bus.emit('e2e:run-started', { runId, framework, flow, device });
          return { runId, started: true, processId };
        } catch (error) {
          run.state = 'error';
          run.error = String(error);
          run.finishedAt = Date.now();
          void ctx.bus.emit('e2e:run-finished', run);
          return { runId, started: false, reason: String(error) };
        }
      },
    });

    ctx.registerRpc('e2e.status', {
      inputSchema: z.object({}),
      handler: async () => ({ runs: [...runs.values()] }),
    });

    ctx.registerRpc('e2e.results', {
      inputSchema: z.object({ runId: z.string() }),
      handler: async ({ runId }) => ({ result: runs.get(runId) ?? null }),
    });

    ctx.registerRpc('e2e.cancel', {
      inputSchema: z.object({ runId: z.string() }),
      handler: async ({ runId }) => {
        await ctx.processes.stop(`e2e:${runId}`);
        const run = runs.get(runId);
        if (run) run.state = 'error';
        return { cancelled: true };
      },
    });
  },
  async teardown() {
    cleanup?.();
    cleanup = undefined;
  },
});
