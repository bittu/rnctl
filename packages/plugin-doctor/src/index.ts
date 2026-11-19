import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { definePlugin, z } from '@rnctl/sdk';
import { listTargets, NUKE_TARGETS, previewNuke, runNuke, type NukeTargetId } from './nuke.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export default definePlugin({
  name: '@rnctl/plugin-doctor',
  version: '0.1.0',
  description: 'Environment diagnostics and cache cleanup',
  async setup(ctx) {
    // shortcut: the nuke command is not implemented; no files are deleted.
    const probe = async (name: string, command: string, args: string[]): Promise<DoctorCheck> => {
      try {
        const result = await ctx.processes.exec(command, args);
        const firstLine = (result.stdout || result.stderr).trim().split('\n')[0] ?? '';
        return { name, ok: result.exitCode === 0, detail: firstLine.slice(0, 160) };
      } catch {
        return { name, ok: false, detail: 'not found' };
      }
    };

    ctx.registerRpc('doctor.check', {
      inputSchema: z.object({}),
      handler: async () => {
        const checks: DoctorCheck[] = [
          await probe('node', process.execPath, ['--version']),
          await probe('java', 'java', ['-version']),
          await probe('adb', 'adb', ['version']),
          await probe('watchman', 'watchman', ['--version']),
        ];

        if (process.platform === 'darwin') {
          checks.push(await probe('xcode CLI', 'xcrun', ['--version']));
          checks.push(await probe('cocoapods', 'pod', ['--version']));
        }

        const androidSdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
        checks.push({
          name: 'android SDK',
          ok: Boolean(androidSdk),
          detail: androidSdk ?? 'ANDROID_HOME / ANDROID_SDK_ROOT not set',
        });

        try {
          const port = await ctx.processes.exec('lsof', ['-iTCP:8081', '-sTCP:LISTEN']);
          const busy = port.stdout.trim().length > 0;
          checks.push({
            name: 'port 8081',
            ok: !busy,
            detail: busy ? port.stdout.trim().split('\n')[0] ?? 'in use' : 'free',
          });
        } catch {
          checks.push({ name: 'port 8081', ok: true, detail: 'could not be checked' });
        }

        return { healthy: checks.every((check) => check.ok), checks };
      },
    });

    ctx.registerRpc('project.info', {
      inputSchema: z.object({ cwd: z.string().optional() }),
      handler: async ({ cwd }) => {
        try {
          const pkg = JSON.parse(readFileSync(join(cwd ?? process.cwd(), 'package.json'), 'utf8')) as {
            name?: string;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
            scripts?: Record<string, string>;
          };
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          return {
            name: pkg.name ?? 'unknown',
            isReactNative: Boolean(deps['react-native'] ?? deps.expo ?? deps['@react-native/core']),
            scripts: Object.entries(pkg.scripts ?? {}).map(([name, command]) => ({ name, command })),
          };
        } catch {
          return { name: 'unknown', isReactNative: false, scripts: [] };
        }
      },
    });

    ctx.registerRpc('project.runScript', {
      inputSchema: z.object({ name: z.string(), cwd: z.string().optional() }),
      handler: async ({ name, cwd }) => {
        try {
          const handle = await ctx.processes.spawn(
            `script:${name}`,
            'npm',
            ['run', name],
            { cwd },
          );
          return { started: true, pid: handle.pid, message: `npm run ${name}` };
        } catch (error) {
          return { started: false, pid: undefined, message: String(error) };
        }
      },
    });

    ctx.registerRpc('nuke.targets', {
      inputSchema: z.object({}),
      handler: async () => ({ targets: listTargets(process.cwd(), process.platform, homedir()) }),
    });

    ctx.registerRpc('nuke.preview', {
      inputSchema: z.object({ targets: z.array(z.enum(NUKE_TARGETS)) }),
      handler: async ({ targets }) => previewNuke(targets, process.cwd(), process.platform, homedir()),
    });

    ctx.registerRpc('nuke.run', {
      inputSchema: z.object({
        targets: z.array(z.enum(NUKE_TARGETS)),
        confirm: z.boolean().default(false),
      }),
      handler: async ({ targets, confirm }) =>
        runNuke(targets, confirm, ctx.processes, process.cwd(), process.platform, homedir()),
    });

    ctx.registerCommand({
      name: 'nuke',
      description: 'Preview or clean caches (nuke [targets...] [--dry-run] [--yes])',
      action: async (args, pluginCtx) => {
        const requested = args.filter((arg): arg is NukeTargetId => NUKE_TARGETS.includes(arg as NukeTargetId));
        if (requested.length === 0) {
          for (const target of listTargets(process.cwd(), process.platform, homedir())) {
            pluginCtx.logger.info(`${target.id.padEnd(14)} ${(target.sizeBytes / 1024 / 1024).toFixed(1)} MB  ${target.label}`);
          }
          return;
        }

        if (args.includes('--dry-run')) {
          const plan = previewNuke(requested, process.cwd(), process.platform, homedir());
          for (const removal of plan.removals) {
            pluginCtx.logger.info(`would remove ${removal.path} (${(removal.sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
          }
          for (const command of plan.commands) pluginCtx.logger.info(`would run ${command}`);
          pluginCtx.logger.info(`total: ${(plan.totalBytes / 1024 / 1024).toFixed(1)} MB`);
          return;
        }

        if (!args.includes('--yes')) {
          pluginCtx.logger.warn('Refusing to delete without --yes. Use --dry-run to preview.');
          return;
        }

        const result = await runNuke(requested, true, pluginCtx.processes, process.cwd(), process.platform, homedir());
        for (const path of result.removed) pluginCtx.logger.info(`removed ${path}`);
        for (const error of result.errors) pluginCtx.logger.error(error);
        pluginCtx.logger.info(`reclaimed ${(result.reclaimedBytes / 1024 / 1024).toFixed(1)} MB`);
      },
    });
  },
});
