import { definePlugin, z } from '@rnctl/sdk';

const PROCESS_ID = 'metro';

export default definePlugin({
  name: '@rnctl/plugin-metro',
  version: '0.1.0',
  description: 'Metro bundler and app build supervision',
  async setup(ctx) {
    // shortcut: Expo project detection is not implemented; Metro CLI is assumed.
    const emit = (topic: string, payload: unknown): void => { void ctx.bus.emit(topic, payload); };
    ctx.registerRpc('metro.start', {
      inputSchema: z.object({
        resetCache: z.boolean().default(false),
        cwd: z.string().optional(),
      }),
      handler: async ({ resetCache, cwd }) => {
        const args = ['react-native', 'start', ...(resetCache ? ['--reset-cache'] : [])];
        try {
          const handle = await ctx.processes.spawn(PROCESS_ID, 'npx', args, { cwd });
          emit('metro:ready', { pid: handle.pid });
          return { started: true, pid: handle.pid };
        } catch (error) {
          ctx.logger.debug(`Metro start skipped: ${String(error)}`);
          emit('metro:error', { message: String(error) });
          return { started: false, pid: undefined };
        }
      },
    });

    ctx.registerRpc('metro.stop', {
      inputSchema: z.object({}),
      handler: async () => {
        await ctx.processes.stop(PROCESS_ID);
        emit('metro:stopped', { id: PROCESS_ID });
        return { stopped: true };
      },
    });

    for (const [method, key, label] of [
      ['metro.reload', 'r', 'Reload'],
      ['metro.devMenu', 'd', 'Dev menu'],
    ] as const) {
      ctx.registerRpc(method, {
        inputSchema: z.object({}),
        handler: async () => {
          try {
            await ctx.processes.write(PROCESS_ID, key);
            return { sent: true };
          } catch (error) {
            ctx.logger.debug(`${label} skipped: ${String(error)}`);
            return { sent: false };
          }
        },
      });
    }

    ctx.registerCommand({
      name: 'metro',
      description: 'Start or stop Metro (start [--reset-cache] | stop)',
      action: async (args, pluginCtx) => {
        if (args[0] === 'stop') {
          await pluginCtx.processes.stop(PROCESS_ID);
          void pluginCtx.bus.emit('metro:stopped', { id: PROCESS_ID });
          pluginCtx.logger.info('Metro stop requested.');
          return;
        }
        const resetCache = args.includes('--reset-cache');
        try {
          const handle = await pluginCtx.processes.spawn(
            PROCESS_ID,
            'npx',
            ['react-native', 'start', ...(resetCache ? ['--reset-cache'] : [])],
          );
          void pluginCtx.bus.emit('metro:ready', { pid: handle.pid });
          pluginCtx.logger.info(`Metro started (pid ${handle.pid ?? 'unknown'}).`);
        } catch (error) {
          void pluginCtx.bus.emit('metro:error', { message: String(error) });
          pluginCtx.logger.warn(`Metro did not start: ${String(error)}`);
        }
      },
    });
  },
});
