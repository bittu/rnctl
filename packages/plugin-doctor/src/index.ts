import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { definePlugin, z } from '@rnctl/sdk';

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

    ctx.registerCommand({
      name: 'nuke',
      description: 'Clean caches and build artifacts',
      action: async (_args, pluginCtx) => {
        pluginCtx.logger.info('Cache cleanup is not implemented yet.');
      },
    });
  },
});
