import { spawn } from 'node:child_process';
import { createDaemon, discoverPlugins, RpcClient } from '@rnctl/core';
import broadcast from '@rnctl/plugin-broadcast';
import devices from '@rnctl/plugin-devices';
import doctor from '@rnctl/plugin-doctor';
import logs from '@rnctl/plugin-logs';
import mcp from '@rnctl/plugin-mcp';
import metro from '@rnctl/plugin-metro';
import network from '@rnctl/plugin-network';
import perf from '@rnctl/plugin-perf';
import storage from '@rnctl/plugin-storage';
import type { Logger } from '@rnctl/sdk';
import { renderDashboard } from '@rnctl/tui';
import { Command } from 'commander';
import { startWebServer, type WebServer } from './web-server.js';

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.unref();
}

// MCP speaks JSON-RPC on stdout; every diagnostic must go to stderr in that mode.
const mcpMode = process.argv.includes('mcp');
const output = mcpMode ? console.error : console.log;
const logger: Logger = {
  debug: (message) => { if (process.env.RNCTL_DEBUG) console.error(message); },
  info: (message) => { output(message); },
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

async function main(): Promise<void> {
  const daemon = createDaemon(logger);
  let webServer: WebServer | undefined;
  for (const plugin of [devices, metro, logs, doctor, broadcast, network, storage, perf, mcp]) {
    await daemon.loader.load(plugin);
  }
  for (const plugin of await discoverPlugins()) {
    if (daemon.loader.list().some((loaded) => loaded.name === plugin.name)) continue;
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
      .allowUnknownOption()
      .action(async (args: string[]) => command.action(args, daemon.ctx));
  }

  program
    .command('web')
    .description('Open the local web dashboard')
    .action(async () => {
      await daemon.start();
      webServer = await startWebServer(daemon.port() ?? 0);
      const url = `http://127.0.0.1:${webServer.port}`;
      logger.info(`Dashboard: ${url}`);
      if (!process.env.RNCTL_NO_BROWSER) openBrowser(url);
      await new Promise<void>(() => {});
    });
  program
    .command('up')
    .description('Start Metro and open the live dashboard')
    .action(async () => {
      await daemon.start();
      const client = await RpcClient.connect(daemon.port());
      await client.call('metro.start', { resetCache: false });
      try {
        await renderDashboard(client);
      } finally {
        await daemon.stop();
      }
    });
  // shortcut: the logs command will stream via logs.list once live tailing lands.
  program
    .command('logs')
    .description('Stream unified native + JS logs')
    .option('-l, --level <level>', 'minimum log level')
    .action(async () => {});

  program.action(async () => {
    await daemon.start();
    try {
      await renderDashboard();
    } finally {
      await daemon.stop();
    }
  });

  const shutdown = (): void => {
    void (async () => {
      await webServer?.stop();
      await daemon.stop();
    })().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
