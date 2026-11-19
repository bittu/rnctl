import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin, z, type PluginContext } from '@rnctl/sdk';

export interface Crash {
  id: string;
  platform: 'ios' | 'android';
  app: string;
  timestamp: number;
  kind: 'js' | 'native';
  source: 'logcat-crash' | 'ips';
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

const CRASH_START = /FATAL EXCEPTION|JavascriptException|signal \d+|Exception in thread/i;

/** Splits logcat crash output into individual crash blocks. */
export function parseLogcatCrashes(output: string, app = 'unknown'): Crash[] {
  const crashes: Crash[] = [];
  const lines = output.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!CRASH_START.test(lines[index] ?? '')) continue;
    const block: string[] = [];
    for (let cursor = index; cursor < lines.length && block.length < 40; cursor += 1) {
      const line = lines[cursor] ?? '';
      if (cursor > index && line.trim() === '') break;
      block.push(line);
    }
    const excerpt = block.join('\n').trim();
    crashes.push({
      id: `android-${index}`,
      platform: 'android',
      app,
      timestamp: Date.now(),
      kind: /JavascriptException/.test(excerpt) ? 'js' : 'native',
      source: 'logcat-crash',
      excerpt,
      frames: block.filter((line) => /^\s*at\s|\d+:\d+|@\d+:\d+/.test(line)).slice(0, 20),
    });
    index += block.length - 1;
  }
  return crashes;
}

/** Extracts frame metrics from `dumpsys gfxinfo` output. */
export function parseGfxInfo(output: string): Partial<Pick<FpsSample, 'jankyPct' | 'p90Ms' | 'p95Ms'>> {
  const janky = output.match(/Janky frames:\s*\d+\s*\(([\d.]+)%\)/);
  const p90 = output.match(/90th percentile:\s*([\d.]+)ms/);
  const p95 = output.match(/95th percentile:\s*([\d.]+)ms/);
  return {
    jankyPct: janky ? Number(janky[1]) : undefined,
    p90Ms: p90 ? Number(p90[1]) : undefined,
    p95Ms: p95 ? Number(p95[1]) : undefined,
  };
}

let timer: ReturnType<typeof setInterval> | undefined;

export default definePlugin({
  name: '@rnctl/plugin-perf',
  version: '0.1.0',
  description: 'Crash collection, symbolication and frame-rate sampling',
  async setup(ctx: PluginContext) {
    // shortcut: native tombstones need adb root and CDP CPU tracing needs an exclusive debugger session.
    const samples: FpsSample[] = [];
    let sampleId = 0;

    ctx.registerRpc('perf.crashes', {
      inputSchema: z.object({
        platform: z.enum(['ios', 'android']).optional(),
        app: z.string().optional(),
        limit: z.number().int().positive().default(50),
      }),
      handler: async ({ platform, app, limit }) => {
        const crashes: Crash[] = [];
        if (platform !== 'ios') {
          try {
            const { stdout } = await ctx.processes.exec('adb', ['logcat', '-d', '-b', 'crash']);
            crashes.push(...parseLogcatCrashes(stdout, app ?? 'android').slice(0, limit));
          } catch (error) {
            ctx.logger.debug(`logcat crash buffer unavailable: ${String(error)}`);
          }
        }
        if (platform !== 'android' && process.platform === 'darwin') {
          try {
            const pattern = join(homedir(), 'Library', 'Logs', 'DiagnosticReports', '*.ips');
            const { stdout } = await ctx.processes.exec('sh', ['-c', `ls -t ${JSON.stringify(pattern)} 2>/dev/null | head -${limit}`]);
            for (const file of stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
              const text = readFileSync(file, 'utf8');
              crashes.push({
                id: `ios-${file}`,
                platform: 'ios',
                app: app ?? 'unknown',
                timestamp: Date.now(),
                kind: /Exception|SIG/i.test(text) ? 'native' : 'js',
                source: 'ips',
                excerpt: text.split('\n').slice(0, 20).join('\n'),
                frames: text.split('\n').filter((line) => /\d+:\d+|\bat\s/.test(line)).slice(0, 20),
              });
            }
          } catch (error) {
            ctx.logger.debug(`.ips scan failed: ${String(error)}`);
          }
        }
        return { crashes };
      },
    });

    ctx.registerRpc('perf.symbolicate', {
      inputSchema: z.object({ sourcemap: z.string(), stack: z.string() }),
      handler: async ({ sourcemap, stack }) => {
        if (!existsSync(sourcemap)) {
          return { available: false, reason: `Source map not found: ${sourcemap}` };
        }
        const scratch = mkdtempSync(join(tmpdir(), 'rnctl-symbolicate-'));
        try {
          const stackFile = join(scratch, 'stack.txt');
          writeFileSync(stackFile, stack);
          const command = `npx metro-symbolicate ${JSON.stringify(sourcemap)} < ${JSON.stringify(stackFile)}`;
          const result = await ctx.processes.exec('sh', ['-c', command]);
          if (result.exitCode !== 0) {
            return { available: false, reason: result.stderr.trim() || `exit ${result.exitCode}` };
          }
          return { available: true, symbolicated: result.stdout };
        } catch (error) {
          return { available: false, reason: String(error) };
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    });

    ctx.registerRpc('perf.fpsStart', {
      inputSchema: z.object({
        app: z.string(),
        intervalMs: z.number().int().positive().default(1000),
      }),
      handler: async ({ app, intervalMs }) => {
        if (timer) return { started: true, id: app, reason: 'Already sampling' };
        const poll = async (): Promise<void> => {
          try {
            const { stdout } = await ctx.processes.exec('adb', ['shell', 'dumpsys', 'gfxinfo', app]);
            const metrics = parseGfxInfo(stdout);
            const sample: FpsSample = {
              id: String(++sampleId),
              timestamp: Date.now(),
              platform: 'android',
              app,
              ...metrics,
              uiFps: metrics.jankyPct === undefined ? undefined : Math.round((100 - metrics.jankyPct) / 100 * 60),
            };
            samples.push(sample);
            if (samples.length > 200) samples.shift();
            void ctx.bus.emit('perf:fps-sample', sample);
          } catch (error) {
            ctx.logger.debug(`gfxinfo sample failed: ${String(error)}`);
          }
        };
        await poll();
        timer = setInterval(() => { void poll(); }, intervalMs);
        return { started: true, id: app };
      },
    });

    ctx.registerRpc('perf.fpsStop', {
      inputSchema: z.object({}),
      handler: async () => {
        if (timer) clearInterval(timer);
        timer = undefined;
        return { stopped: true };
      },
    });

    ctx.registerRpc('perf.fpsSamples', {
      inputSchema: z.object({ limit: z.number().int().positive().default(100) }),
      handler: async ({ limit }) => ({ samples: samples.slice(-limit) }),
    });
  },
  async teardown() {
    if (timer) clearInterval(timer);
    timer = undefined;
  },
});
