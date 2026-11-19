import { definePlugin, z, type PluginContext } from '@rnctl/sdk';

type Platform = 'ios' | 'android' | 'metro';

interface Target {
  id: string;
  platform: 'ios' | 'android';
}

interface ActionResult {
  id: string;
  platform: Platform;
  ok: boolean;
  message: string;
}

async function bootedDevices(ctx: PluginContext): Promise<Target[]> {
  const targets: Target[] = [];
  try {
    const { stdout } = await ctx.processes.exec('adb', ['devices', '-l']);
    for (const line of stdout.split('\n').slice(1)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial && state === 'device') targets.push({ id: serial, platform: 'android' });
    }
  } catch { /* adb unavailable */ }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await ctx.processes.exec('xcrun', ['simctl', 'list', 'devices', '-j']);
      const parsed = JSON.parse(stdout) as {
        devices?: Record<string, Array<{ udid?: string; state?: string; isAvailable?: boolean }>>;
      };
      for (const list of Object.values(parsed.devices ?? {})) {
        for (const device of list) {
          if (device.udid && device.state === 'Booted' && device.isAvailable !== false) {
            targets.push({ id: device.udid, platform: 'ios' });
          }
        }
      }
    } catch { /* simctl unavailable */ }
  }
  return targets;
}

export default definePlugin({
  name: '@rnctl/plugin-broadcast',
  version: '0.1.0',
  description: 'Broadcast actions to all booted React Native devices',
  async setup(ctx) {
    // shortcut: iOS JS reload needs a simulator UI bridge; Metro reload covers JS, Android uses input text.
    const dispatch = async (
      targets: Target[],
      commandFor: (target: Target) => { executable: string; args: string[] } | undefined,
    ): Promise<ActionResult[]> => {
      const results: ActionResult[] = [];
      for (const target of targets) {
        const command = commandFor(target);
        if (!command) {
          results.push({ ...target, ok: false, message: 'not supported on this platform' });
          continue;
        }
        try {
          const outcome = await ctx.processes.exec(command.executable, command.args);
          const message = (outcome.stderr || outcome.stdout).trim().split('\n')[0] ?? 'ok';
          results.push({ ...target, ok: outcome.exitCode === 0, message: message.slice(0, 160) || 'ok' });
        } catch (error) {
          results.push({ ...target, ok: false, message: String(error) });
        }
      }
      return results;
    };

    const reload = async (): Promise<{ results: ActionResult[]; sent: number }> => {
      const results = await dispatch(await bootedDevices(ctx), (target) => target.platform === 'android'
        ? { executable: 'adb', args: ['-s', target.id, 'shell', 'input', 'text', 'rr'] }
        : undefined);
      try {
        await ctx.processes.write('metro', 'r');
        results.push({ id: 'metro', platform: 'metro', ok: true, message: 'Metro JS reloaded' });
      } catch {
        results.push({ id: 'metro', platform: 'metro', ok: false, message: 'Metro is not running' });
      }
      return { results, sent: results.filter((result) => result.ok).length };
    };

    ctx.registerRpc('broadcast.reload', {
      inputSchema: z.object({}),
      handler: reload,
    });

    const deepLink = async (url: string) => {
      const results = await dispatch(await bootedDevices(ctx), (target) => target.platform === 'android'
        ? { executable: 'adb', args: ['-s', target.id, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url] }
        : { executable: 'xcrun', args: ['simctl', 'openurl', target.id, url] });
      return { results, sent: results.filter((result) => result.ok).length };
    };

    const darkMode = async (enabled: boolean) => {
      const results = await dispatch(await bootedDevices(ctx), (target) => target.platform === 'android'
        ? { executable: 'adb', args: ['-s', target.id, 'shell', 'cmd', 'uimode', 'night', enabled ? 'yes' : 'no'] }
        : { executable: 'xcrun', args: ['simctl', 'ui', target.id, 'appearance', enabled ? 'dark' : 'light'] });
      return { results, sent: results.filter((result) => result.ok).length };
    };

    ctx.registerRpc('broadcast.deepLink', {
      inputSchema: z.object({ url: z.string().url() }),
      handler: ({ url }) => deepLink(url),
    });

    ctx.registerRpc('broadcast.darkMode', {
      inputSchema: z.object({ enabled: z.boolean() }),
      handler: ({ enabled }) => darkMode(enabled),
    });

    ctx.registerCommand({
      name: 'broadcast',
      description: 'Broadcast to all booted devices (reload | deeplink <url> | dark on|off)',
      action: async (args, pluginCtx) => {
        const [action, ...rest] = args;
        let result: { sent: number; results: ActionResult[] } | undefined;
        if (action === 'reload') result = await reload();
        else if (action === 'deeplink' && rest[0]) result = await deepLink(rest[0]);
        else if (action === 'dark') result = await darkMode(rest[0] !== 'off');
        else {
          pluginCtx.logger.warn('Usage: broadcast reload | deeplink <url> | dark on|off');
          return;
        }
        for (const item of result.results) {
          pluginCtx.logger.info(`${item.id}: ${item.ok ? 'ok' : item.message}`);
        }
        pluginCtx.logger.info(`Broadcast reached ${result.sent} targets.`);
      },
    });
  },
});
