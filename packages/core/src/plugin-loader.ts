import type { PluginContext, RnctlPlugin } from '@rnctl/sdk';

export class PluginLoader {
  private readonly plugins: RnctlPlugin[] = [];

  constructor(private readonly ctx: PluginContext) {}

  async load(plugin: RnctlPlugin): Promise<void> {
    await plugin.setup(this.ctx);
    this.plugins.push(plugin);
  }

  async unloadAll(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      await plugin.teardown?.(this.ctx);
    }
    this.plugins.length = 0;
  }

  list(): readonly RnctlPlugin[] {
    return this.plugins;
  }
}
