import { defineConfig } from 'tsdown';

export default defineConfig({
  dts: true,
  clean: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  failOnWarn: false,
});
