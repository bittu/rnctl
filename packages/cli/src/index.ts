import { createDaemon, RpcClient } from '@rnctl/core';
import devices from '@rnctl/plugin-devices';
import doctor from '@rnctl/plugin-doctor';
import logs from '@rnctl/plugin-logs';
import metro from '@rnctl/plugin-metro';
import type { Logger } from '@rnctl/sdk';
import { renderDashboard } from '@rnctl/tui';
import { Command } from 'commander';

const logger: Logger = {
  debug: (message) => { if (process.env.RNCTL_DEBUG) console.debug(message); },
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

async function main(): Promise<void> {
  const daemon = createDaemon(logger);
  for (const plugin of [devices, metro, logs, doctor]) {
    await daemon.loader.load(plugin);
  }

  const program = new Command();
  program
    .name('rnctl')
    .description('One mission control for React Native')
    .version('0.1.0');

  for (const command of daemon.commands()) {
    program
      .command(command.name)
      .description(command.description)
      .argument('[args...]')
      .action(async (args: string[]) => command.action(args, daemon.ctx));
  }

  // shortcut: web/up/logs are shell placeholders until the daemon transport lands.
  program
    .command('web')
    .description('Open the local web dashboard')
    .action(async () => {});
  program
    .command('up')
    .description('Start Metro and open the live dashboard')
    .action(async () => {
      await daemon.start();
      const client = await RpcClient.connect(daemon.port());
      await client.call('metro.start', { resetCache: false });
      await renderDashboard(client);
    });
  program
    .command('logs')
    .description('Stream unified native + JS logs')
    .option('-l, --level <level>', 'minimum log level')
    .action(async () => {});

  program.action(async () => {
    await daemon.start();
    await renderDashboard();
  });

  const shutdown = (): void => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
