import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { rnctl: 'src/index.ts' },
  banner: { js: '#!/usr/bin/env node' },
  dts: true,
  clean: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  failOnWarn: false,
});
