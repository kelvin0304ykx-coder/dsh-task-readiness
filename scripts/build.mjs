import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
/** Peer services are supplied by the host, never bundled: the plugin must use the host's instances. */
const external = ['@deepseek-ai/*', 'node:*'];
await rm(new URL('../lib', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../lib/index.js', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
