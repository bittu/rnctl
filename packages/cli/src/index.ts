import { createDaemon } from '@rnctl/core';
import { renderDashboard } from '@rnctl/tui';
import { Command } from 'commander';

const program = new Command();

program
  .name('rnctl')
  .description('One mission control for React Native')
  .version('0.1.0');

program
  .command('web')
  .description('Open the local web dashboard')
  .action(async () => {});

program
  .command('up')
  .description('Boot a device, start Metro, and launch the app')
  .action(async () => {});

program
  .command('logs')
  .description('Stream unified native + JS logs')
  .option('-l, --level <level>', 'minimum log level')
  .action(async () => {});

program
  .command('nuke')
  .description('Clean caches and build artifacts')
  .action(async () => {});

program.action(async () => {
  const daemon = createDaemon();
  await daemon.start();
  renderDashboard();
});

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
