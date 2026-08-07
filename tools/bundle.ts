/**
 * Bundle the Lambda into a deployable zip.
 *
 *   npm run bundle
 *
 * One zip, two entry points: the Alexa skill and the MCP HTTP endpoint. A single function
 * serves both (plan §3.1), so they share a bundle and a warm container.
 *
 * Bundling rather than shipping `node_modules` is what keeps the cold start inside the
 * ≤600ms budget — the AWS SDK alone is tens of megabytes unbundled, and cold start is
 * charged against Alexa's ~8 second ceiling on the very first command of the day.
 */

import { build } from 'esbuild';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT_DIR = resolve('infra/build');
const ZIP_PATH = resolve('infra/build/lambda.zip');

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  await build({
    entryPoints: {
      // Names the Terraform references as `<name>.handler`.
      alexa: resolve('packages/lambda-api/src/handler.ts'),
      mcp: resolve('packages/lambda-api/src/mcp-http.ts'),
    },
    bundle: true,
    platform: 'node',
    // Matches the Lambda runtime in infra/main.tf. Bundling for a newer target than the
    // runtime produces syntax errors that only appear at invocation time.
    target: 'node22',
    format: 'esm',
    outdir: OUT_DIR,
    outExtension: { '.js': '.mjs' },
    sourcemap: false,
    minify: true,
    // esbuild cannot see through these two; without the shim, `require` is undefined in an
    // ESM bundle and the AWS SDK's CJS dependencies fail at import time.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'module';",
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'warning',
  });

  execFileSync('zip', ['-qj', ZIP_PATH, resolve(OUT_DIR, 'alexa.mjs'), resolve(OUT_DIR, 'mcp.mjs')]);

  const size = (await stat(ZIP_PATH)).size;
  console.log(`✅ ${ZIP_PATH}`);
  console.log(`   ${(size / 1024 / 1024).toFixed(2)} MB`);

  // 50 MB is the direct-upload ceiling; well before that, size is cold-start latency.
  if (size > 25 * 1024 * 1024) {
    console.warn('   ⚠ Large for a zip Lambda — cold start is charged against Alexa’s budget.');
  }
}

main().catch((error: unknown) => {
  console.error('\n⛔', error);
  process.exit(1);
});
