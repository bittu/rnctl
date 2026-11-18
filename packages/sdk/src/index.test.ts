import { describe, expect, it } from 'vitest';
import { definePlugin } from './index.js';

describe('definePlugin', () => {
  it('returns the plugin definition unchanged', () => {
    const plugin = definePlugin({
      name: '@rnctl/plugin-test',
      version: '0.0.0',
      description: 'test plugin',
      async setup() {},
    });
    expect(plugin.name).toBe('@rnctl/plugin-test');
  });
});
