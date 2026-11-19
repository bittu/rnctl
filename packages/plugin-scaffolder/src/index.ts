import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { definePlugin } from '@rnctl/sdk';
import { pluginTemplates } from './templates.js';

const VALID_NAME = /^[a-z][a-z0-9-]*$/;

export default definePlugin({
  name: '@rnctl/plugin-scaffolder',
  version: '0.1.0',
  description: 'Scaffold publishable rnctl-plugin-* packages',
  async setup(ctx) {
    // shortcut: templates target pnpm + tsup; generated packages can be adapted to other toolchains.
    ctx.registerCommand({
      name: 'plugin',
      description: 'Create a plugin (plugin create <name>)',
      action: async (args, pluginCtx) => {
        if (args[0] !== 'create' || !args[1]) {
          pluginCtx.logger.warn('Usage: rnctl plugin create <name>');
          return;
        }
        const name = args[1];
        if (!VALID_NAME.test(name)) {
          pluginCtx.logger.error('Name must be lowercase letters, digits and hyphens, starting with a letter.');
          return;
        }

        const target = resolve(join(process.cwd(), `rnctl-plugin-${name}`));
        if (existsSync(target)) {
          pluginCtx.logger.error(`Refusing to overwrite existing directory: ${target}`);
          return;
        }

        for (const [relative, content] of Object.entries(pluginTemplates(name))) {
          const file = join(target, relative);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, content);
        }

        pluginCtx.logger.info(`Created ${target}`);
        pluginCtx.logger.info('Next: pnpm install && pnpm typecheck && pnpm test && pnpm build');
      },
    });
  },
});
